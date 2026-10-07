/**
 * Loop gates: a command that runs when a gated loop comes due and decides
 * whether the model wakes. The gate prints one JSON line on stdout:
 *
 *   {"action": "skip" | "wake" | "defer", "reason": "...", "context": "...", "retryIn": "2m"}
 *
 * skip  -> no model turn; the loop waits for its next slot
 * wake  -> the loop's prompt is sent, with `reason` and `context` appended
 * defer -> run the gate again after `retryIn` (e.g. to confirm a failure)
 *
 * Anything else (non-zero exit, timeout, no JSON) is a gate error and takes
 * the loop's `onError` action (default wake), so a broken gate cannot keep a
 * session asleep. The command is a file inside the loop's folder (the project, or the
 * loop's `dir`), run without a shell, with cwd = that folder and LOOP_ID / LOOP_STATE_DIR / LOOP_LAST_WOKE_AT set, and
 * LOOP_TEST=1 on a `/loop test` run (decide, but record nothing).
 *
 * PI_SESSION_ID / PI_SESSION_FILE are the owning session's, the same values Pi's
 * bash tool exposes, so a gate can act on behalf of its session. Values
 * inherited from the Pi process's own environment (a parent session that
 * launched it) are dropped first: no identity is better than someone else's.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseInterval } from "./schedule.ts";

export const DEFAULT_GATE_TIMEOUT_MS = 60_000;
export const MAX_CONTEXT_CHARS = 4_000;
export const MIN_RETRY_MS = 15_000;

export interface GateConfig {
	/** Path relative to the loop's folder (the project, unless the loop has a dir); must stay inside it. */
	command: string;
	timeoutMs: number;
	/** Wake without asking the gate once this long has passed since the last wake. */
	maxSleepMs?: number;
	onError: "wake" | "skip";
}

export interface GateDecision {
	action: "skip" | "wake" | "defer";
	reason: string;
	context?: string;
	retryInMs?: number;
	error?: boolean;
	/** Not the gate's: the loop's maxSleep was reached, so it woke without asking the gate. */
	heartbeat?: boolean;
}

/** Resolve a gate path inside `cwd`; returns the absolute path or an error message. */
export function resolveGate(cwd: string, command: string): { path: string } | { error: string } {
	const rel = command.trim();
	if (!rel) return { error: "gate path is empty" };
	if (path.isAbsolute(rel)) return { error: "gate must be a path relative to the project, e.g. .pi/gates/check" };
	let root: string;
	try { root = fs.realpathSync(cwd); } catch { return { error: `the loop's folder ${cwd} does not exist` }; }
	let abs: string;
	try { abs = fs.realpathSync(path.resolve(root, rel)); } catch { return { error: `gate ${rel} does not exist` }; }
	if (abs !== root && !abs.startsWith(root + path.sep)) return { error: "gate must be inside the project" };
	try {
		const st = fs.statSync(abs);
		if (!st.isFile()) return { error: `gate ${rel} is not a file` };
		fs.accessSync(abs, fs.constants.X_OK);
	} catch { return { error: `gate ${rel} is not executable (chmod +x)` }; }
	return { path: abs };
}

/** The last stdout line that parses as a decision object. */
export function parseDecision(stdout: string): GateDecision | undefined {
	const lines = stdout.split("\n").map(l => l.trim()).filter(Boolean).reverse();
	for (const line of lines) {
		let o: any;
		try { o = JSON.parse(line); } catch { continue; }
		if (!o || typeof o !== "object" || !["skip", "wake", "defer"].includes(o.action)) continue;
		const d: GateDecision = { action: o.action, reason: String(o.reason ?? "").slice(0, 300) || o.action };
		if (o.context !== undefined) {
			const c = typeof o.context === "string" ? o.context : JSON.stringify(o.context);
			d.context = c.length > MAX_CONTEXT_CHARS ? `${c.slice(0, MAX_CONTEXT_CHARS)}…[truncated]` : c;
		}
		if (d.action === "defer") {
			const ms = typeof o.retryIn === "number" ? o.retryIn * 1000 : parseInterval(String(o.retryIn ?? "")) ?? parseSeconds(o.retryIn);
			d.retryInMs = Math.max(MIN_RETRY_MS, ms ?? 60_000);
		}
		return d;
	}
	return undefined;
}

function parseSeconds(v: unknown): number | undefined {
	const m = /^(\d+)s$/.exec(String(v ?? "").trim());
	return m ? Number(m[1]) * 1000 : undefined;
}

/** The session that owns the loop, as Pi's bash tool exposes it. */
export interface GateSession { id?: string; file?: string }

export interface GateInput {
	id: string; prompt: string; lastWokeAt?: number; stateDir: string;
	/** `/loop test`: the gate should decide without recording anything. */
	test?: boolean;
	/** Owning session; becomes PI_SESSION_ID / PI_SESSION_FILE. */
	session?: GateSession;
}

/** The gate's environment: Pi's own minus any inherited session identity, plus the loop's values. */
export function gateEnv(input: GateInput, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	if (input.session?.id) env.PI_SESSION_ID = input.session.id;
	if (input.session?.id && input.session.file) env.PI_SESSION_FILE = input.session.file;
	env.LOOP_ID = input.id;
	env.LOOP_PROMPT = input.prompt;
	env.LOOP_STATE_DIR = input.stateDir;
	env.LOOP_LAST_WOKE_AT = input.lastWokeAt ? new Date(input.lastWokeAt).toISOString() : "";
	env.LOOP_TEST = input.test ? "1" : "";
	return env;
}

/** Run the gate once. Never throws: failures become the loop's onError action. */
export function runGate(cwd: string, cfg: GateConfig, input: GateInput): Promise<GateDecision> {
	const onError = (reason: string): GateDecision => ({ action: cfg.onError, reason: `gate error: ${reason}`, error: true });
	const resolved = resolveGate(cwd, cfg.command);
	if ("error" in resolved) return Promise.resolve(onError(resolved.error));
	try { fs.mkdirSync(input.stateDir, { recursive: true, mode: 0o700 }); } catch { /* the gate may not need it */ }
	const env = gateEnv(input);
	return new Promise(resolve => {
		execFile(resolved.path, [], { cwd, env, timeout: cfg.timeoutMs, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
			if (err) {
				const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
				if (e.killed) return resolve(onError(`timed out after ${Math.round(cfg.timeoutMs / 1000)}s`));
				const tail = String(stderr || "").trim().split("\n").at(-1)?.slice(0, 200);
				return resolve(onError(`exit ${e.code ?? "?"}${tail ? `: ${tail}` : ""}`));
			}
			resolve(parseDecision(String(stdout)) ?? onError("no JSON decision on stdout"));
		});
	});
}

/** Append one decision to the project's gate log, keeping it bounded. */
export function logDecision(file: string, entry: Record<string, unknown>) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* new file */ }
		fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
	} catch { /* logging must not break the loop */ }
}
