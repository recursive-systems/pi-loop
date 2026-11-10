/**
 * Model fallback for background runs. A loop's `model` is one model or an ordered list of them:
 *
 *   "model": "provider/id:high"                         one model, as before
 *   "model": ["provider/a:high", "provider/b:medium"]   the first available one, then the next
 *
 * A model is held back for this folder's loops when a run on it failed for want of it, before doing
 * anything (see index.ts): 30 minutes by default (`loop.modelBackoff`), doubling each time it is tried
 * again and still fails, up to 8 times that. Once its hold ends a run tries it first again, so loops go
 * back to their first choice on their own. An optional check command (`loop.modelCheck`) can say which
 * models are unavailable, or available, right now (a quota meter, say).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type ModelSpec = string | string[];

/** A model held back after it failed, by its provider/id: until when, how many holds in a row, and why. */
export interface Hold { until: number; tries: number; why?: string }
export type Holds = Record<string, Hold>;

/** What a check command knows: models it says are unavailable, and models it says are fine. Others it doesn't track. */
export interface CheckAnswer { unavailable: Set<string>; available: Set<string> }

export const DEFAULT_MODEL_BACKOFF_MS = 30 * 60_000;
export const MAX_BACKOFF_FACTOR = 8;
const MAX_MODELS = 5;
const CHECK_TIMEOUT_MS = 10_000;
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** A loop's models in order of preference (empty: the session's model). */
export function modelList(spec: ModelSpec | undefined): string[] {
	return spec === undefined ? [] : typeof spec === "string" ? [spec] : spec;
}

/** provider/id[:thinking] split into Pi's --model and --thinking. */
export function splitModel(choice: string): { model: string; thinking?: string } {
	const i = choice.lastIndexOf(":");
	const level = i > 0 ? choice.slice(i + 1) : "";
	return THINKING.has(level) ? { model: choice.slice(0, i), thinking: level } : { model: choice };
}

/** The model a choice names, without its thinking level: what is held back and compared. */
export const modelKey = (choice: string) => splitModel(choice).model;

function looksLikeModel(v: unknown): v is string {
	if (typeof v !== "string" || /\s/.test(v)) return false;
	const slash = v.indexOf("/");
	return slash > 0 && slash < v.length - 1;
}

/** A declared or requested `model`: one provider/id[:thinking], or a list of them. Throws with what is wrong. */
export function parseModels(v: unknown): ModelSpec | undefined {
	if (v === undefined) return undefined;
	const list = Array.isArray(v) ? v : [v];
	if (!list.length || list.length > MAX_MODELS || !list.every(looksLikeModel))
		throw new Error(`model must look like provider/id or provider/id:thinking, or be a list of up to ${MAX_MODELS} of them (first choice first)`);
	if (new Set(list.map(modelKey)).size !== list.length) throw new Error("model lists the same model twice");
	return list.length === 1 ? list[0] : list;
}

/** Held back now: the check says unavailable, or its hold hasn't ended and the check doesn't say it is fine. */
export function heldNow(key: string, holds: Holds, now: number, check?: CheckAnswer): boolean {
	if (check?.unavailable.has(key)) return true;
	return (holds[key]?.until ?? 0) > now && !check?.available.has(key);
}

/**
 * The models a pick of `picked` passed over without trying them (earlier in `chain`, not tried yet), and why:
 * the check said unavailable, or a hold (until when, and its own reason) that the check didn't override.
 */
export function skippedFor(chain: string[], picked: string, holds: Holds, now: number, tried: string[] = [], check?: CheckAnswer): { model: string; why: string; until?: string; after?: string }[] {
	return chain.slice(0, chain.indexOf(picked)).filter(c => !tried.includes(c)).map(modelKey).flatMap(key => {
		if (check?.unavailable.has(key)) return [{ model: key, why: "check_unavailable" }];
		const h = holds[key];
		return heldNow(key, holds, now, check) && h ? [{ model: key, why: "held", until: new Date(h.until).toISOString(), ...(h.why ? { after: h.why } : {}) }] : [];
	});
}

/**
 * The model a run uses: the first one not tried yet in this fire and not held back. When every
 * model is held back, a fire's first attempt still runs, on its first choice; later attempts stop.
 */
export function pickModel(chain: string[], holds: Holds, now: number, tried: string[] = [], check?: CheckAnswer): string | undefined {
	const left = chain.filter(c => !tried.includes(c));
	return left.find(c => !heldNow(modelKey(c), holds, now, check)) ?? (tried.length ? undefined : chain[0]);
}

/** Hold a model back after a failure; `started` when this begins a new hold (it wasn't held a moment ago). */
export function holdModel(holds: Holds, key: string, now: number, backoffMs: number, why: string): { hold: Hold; started: boolean } {
	const prev = holds[key];
	// Failing again during a hold (another loop's run that had started already) changes nothing; failing
	// again after it ended doubles the next one.
	if (prev && prev.until > now) return { hold: prev, started: false };
	const tries = (prev?.tries ?? 0) + 1;
	const hold = { until: now + backoffMs * Math.min(2 ** (tries - 1), MAX_BACKOFF_FACTOR), tries, why };
	holds[key] = hold;
	return { hold, started: true };
}

/** The saved holds, none ending later than `maxMs` from now (a hand edit or a clock jump can't hold a model longer). */
export function readHolds(file: string, now: number, maxMs: number): Holds {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"))?.models;
		const out: Holds = {};
		for (const [k, h] of Object.entries(raw ?? {}) as [string, any][]) {
			if (Number.isFinite(h?.until) && Number.isFinite(h?.tries)) out[k] = { until: Math.min(h.until, now + maxMs), tries: h.tries, ...(typeof h.why === "string" ? { why: h.why } : {}) };
		}
		return out;
	} catch { return {}; }
}

export function writeHolds(file: string, holds: Holds) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (!Object.keys(holds).length) { fs.rmSync(file, { force: true }); return; }
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ v: 1, models: holds }, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/**
 * Ask the check command (an executable's absolute path) about `models`. It runs without a shell, in the
 * project, with the models (provider/id) as its arguments, and prints {"unavailable": [...], "available": [...]}
 * as its last JSON line; a model in neither list is one it doesn't track. Undefined when it fails.
 */
export function checkModels(command: string, cwd: string, models: string[]): Promise<CheckAnswer | undefined> {
	const keys = (v: unknown) => new Set((Array.isArray(v) ? v : []).filter((m): m is string => typeof m === "string").map(modelKey));
	return new Promise(resolve => {
		try {
			execFile(command, models, { cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: 256 * 1024, killSignal: "SIGKILL" }, (err, stdout) => {
				if (err) return resolve(undefined);
				for (const line of String(stdout).split("\n").map(l => l.trim()).filter(Boolean).reverse()) {
					let o: any;
					try { o = JSON.parse(line); } catch { continue; }
					if (Array.isArray(o?.unavailable) || Array.isArray(o?.available)) return resolve({ unavailable: keys(o.unavailable), available: keys(o.available) });
				}
				resolve(undefined);
			});
		} catch { resolve(undefined); }
	});
}
