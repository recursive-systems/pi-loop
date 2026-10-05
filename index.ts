/**
 * loop: recurring prompts in this session, in the spirit of Claude Code's /loop.
 *
 *   /loop [interval] <prompt>      interval = 10m default; 5m, 2h, 1d; or `at 07:30 [Area/City]` (daily)
 *
 * `at` times are wall-clock times in a zone, DST-aware: the loop's own zone if
 * given, else `loop.timezone` in .pi/settings.json or <agent-dir>/settings.json,
 * else the system zone. See schedule.ts for the DST edge rules.
 *   /loop                          list loops
 *   /loop rm|pause|resume|run <id> manage one (only when <id> is an existing loop)
 *   /loop clear                    delete all
 *
 * When a loop is due and the session is idle, its gate (if any) runs and its prompt
 * is sent as a user message that starts a turn. While the session is busy, a due
 * loop waits: it is not queued behind the current turn, it never stacks (a 5m loop
 * through a 20-minute turn fires once, afterwards), and its gate runs only once the
 * session is free, so the turn gets fresh evidence. When several loops are waiting,
 * the highest `priority` goes first, then the longest overdue. The turn shares this
 * session's context, which is the point of this design over a scheduled child.
 *
 * A loop may have its own folder (`dir`, inside the project): its gate, prompt
 * template and state are found there, and `context` files from it are attached to
 * its turn. Loops can also be declared in `.pi/loop.json` files, in the project or
 * in any folder directly under it; a declared loop's folder is the one holding the
 * file, and editing the file changes the loop (run state stays in .pi/loops.json). Loops persist in
 * .pi/loops.json and are restored on session start; a due loop missed while no
 * session was alive fires once on start (catchUp "latest") unless it is a short
 * interval (< 1h), which just advances. One session owns the loops per project
 * (.pi/loops.lock); a second session sees them read-only until the owner dies.
 *
 * Deliberate deviations from Claude Code: loops survive session restarts, and
 * `at HH:MM` exists because the daily job is the case this was built for.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, describe, fmtTime, nextAtFor, parseAt, parseInterval, validZone, systemZone,
	type Schedule,
} from "./schedule.ts";
import { HerdrTokens, countdown, loopTokens, type Phase } from "./herdr.ts";
import { DEFAULT_GATE_TIMEOUT_MS, logDecision, resolveGate, runGate, type GateConfig, type GateDecision, type GateSession } from "./gate.ts";
import { compose, type CommandInfo } from "./prompt.ts";
import { FolderLock, lockAvailable } from "./lock.ts";

const STATUS_KEY = "loop";
const TICK_MS = 15_000;
const CATCH_UP_MIN_MS = 60 * 60_000;
/** While a gate keeps failing, remind (wake) at most this often. */
const GATE_ERROR_REWAKE_MS = 6 * 60 * 60_000;

interface Loop {
	id: string;
	prompt: string;
	schedule: Schedule;
	/** IANA zone for `at` loops, when set explicitly; otherwise the configured default. */
	tz?: string;
	catchUp: "latest" | "none";
	paused: boolean;
	createdAt: number;
	nextAt: number;
	lastFiredAt?: number;
	fires: number;
	/** Optional gate: a project script that decides whether a due fire wakes the model. */
	gate?: GateConfig;
	/** Last time the model was actually woken (fires counts wakes). */
	lastWokeAt?: number;
	gateRuns?: number;
	lastGate?: { at: number; action: string; reason: string };
	/** Consecutive gate errors, and when one last woke the model (error backoff). */
	gateErrors?: number;
	gateErrorWokeAt?: number;
	/** Higher goes first when several loops are waiting for the session. Default 0. */
	priority?: number;
	/** The loop's own folder, relative to the project: gate, prompt template and state are found there. */
	dir?: string;
	/** Files in the loop's folder (or the project) attached to each turn, e.g. AGENTS.md. */
	context?: string[];
	/** The .pi/loop.json that declares this loop, relative to the project; edit the loop there. */
	source?: string;
	/** The `paused` its declaration last said, so only a change to it pauses or resumes the loop. */
	declaredPaused?: boolean;
	/** Bumped whenever the loop's definition changes, so a gate run for an older definition is discarded. */
	rev?: number;
	/**
	 * A gate said wake but the turn couldn't be sent yet (the session was busy, or shutting down).
	 * Gates may record what they reported, so the wake is kept, with its reason and context, and
	 * sent once the session is free; the gate isn't run again. Dropped if the loop is redefined.
	 */
	pendingWake?: { reason: string; context?: string; at: number; rev: number };
}

/** Most text attached from context files to one turn. */
const MAX_LOOP_CONTEXT_CHARS = 64_000;
/** A declaration in a .pi/loop.json file. */
interface Declared {
	id: string; prompt: string; every?: string; at?: string; timezone?: string;
	gate?: string; maxSleep?: string; gateTimeout?: string; gateOnError?: string;
	priority?: number; context?: string[]; paused?: boolean;
}

// ------------------------------------------------------------ settings --

/** Pi's agent dir (PI_CODING_AGENT_DIR, default ~/.pi/agent), without a runtime import of Pi. */
function agentDir(): string {
	const dir = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!dir) return path.join(os.homedir(), ".pi", "agent");
	return dir === "~" ? os.homedir() : dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : path.resolve(dir);
}

/**
 * Default zone for `at` loops: `loop.timezone` from the project's
 * .pi/settings.json, else the agent dir's settings.json, else the system zone.
 */
export function configuredZone(cwd: string): { tz: string; source: string; warning?: string } {
	const files = [path.join(cwd, ".pi", "settings.json"), path.join(agentDir(), "settings.json")];
	for (const file of files) {
		let raw: unknown;
		try { raw = (JSON.parse(fs.readFileSync(file, "utf8")) as { loop?: { timezone?: unknown } }).loop?.timezone; } catch { continue; }
		if (raw === undefined) continue;
		const tz = typeof raw === "string" ? validZone(raw) : undefined;
		if (tz) return { tz, source: file };
		return { tz: systemZone(), source: "system", warning: `loop.timezone ${JSON.stringify(raw)} in ${file} is not an IANA zone; using ${systemZone()}` };
	}
	return { tz: systemZone(), source: "system" };
}

function slug(prompt: string): string {
	const words = prompt.replace(/^\/+/, "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").trim().split(/\s+/).slice(0, 3);
	return words.join("-") || "loop";
}

/**
 * Split "[interval|at HH:MM [Zone/Name]] prompt" per Claude's /loop shape;
 * default 10m. A zone is taken only when the token after HH:MM is a valid IANA
 * name containing "/" (America/Chicago) or is UTC; otherwise it is the prompt.
 */
function parseAdd(args: string): { schedule: Schedule; prompt: string; tz?: string } | { error: string } {
	let tz: string | undefined;
	const tokens = args.trim().split(/\s+/);
	let schedule: Schedule = { kind: "every", ms: DEFAULT_INTERVAL_MS };
	let rest = tokens;
	const every = parseInterval(tokens[0] ?? "");
	if (every !== undefined) {
		if (every < MIN_INTERVAL_MS) return { error: "minimum interval is 1m" };
		schedule = { kind: "every", ms: every };
		rest = tokens.slice(1);
	} else if (tokens[0]?.toLowerCase() === "at") {
		const at = parseAt(tokens[1] ?? "");
		if (!at) return { error: "usage: /loop at HH:MM <prompt>" };
		schedule = { kind: "at", ...at };
		rest = tokens.slice(2);
		const maybeZone = rest[0] ?? "";
		if (/\//.test(maybeZone) || /^utc$/i.test(maybeZone)) {
			tz = validZone(maybeZone);
			if (tz) rest = rest.slice(1);
			else if (/^[A-Za-z_]+\/[A-Za-z_\/+-]+$/.test(maybeZone)) return { error: `unknown time zone "${maybeZone}"` };
		}
	}
	const prompt = rest.join(" ").trim();
	if (!prompt) return { error: "usage: /loop [10m|2h|1d|at HH:MM [Area/City]] <prompt>" };
	return { schedule, prompt, tz };
}

// ----------------------------------------------------------------- storage --

/**
 * The session a gate runs for, read when it runs (so a /new or /resume is followed),
 * the way Pi's bash tool builds PI_SESSION_ID / PI_SESSION_FILE.
 */
function sessionOf(c: ExtensionContext | undefined): GateSession {
	try {
		const sm = c?.sessionManager;
		const id = sm?.getSessionId();
		if (!id) return {};
		const file = sm?.getSessionFile();
		return file ? { id, file } : { id };
	} catch { return {}; }
}

/** A folder inside the project, normalized relative to it; undefined for the project itself. Throws if outside. */
function insideDir(cwd: string, dir: string | undefined): string | undefined {
	if (!dir || dir === "." || dir === "./") return undefined;
	if (path.isAbsolute(dir)) throw new Error("dir must be a folder relative to the project");
	const root = fs.realpathSync(cwd);
	let abs: string;
	try { abs = fs.realpathSync(path.resolve(root, dir)); } catch { throw new Error(`dir ${dir} does not exist`); }
	if (abs === root) return undefined;
	if (!abs.startsWith(root + path.sep)) throw new Error("dir must be inside the project");
	if (!fs.statSync(abs).isDirectory()) throw new Error(`dir ${dir} is not a folder`);
	return path.relative(root, abs);
}

export default function loopExtension(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let file = "";
	let lock = "";
	let readOnly = false;
	let loops: Loop[] = [];
	let zone: ReturnType<typeof configuredZone> = { tz: systemZone(), source: "system" };
	const herdr = new HerdrTokens();
	let herdrPane = false;
	let phase: Phase;
	let phaseAt = 0;
	/** Loops whose gate is running now; they are not due again until it returns. */
	const gating = new Set<string>();
	/** Gates still running, so shutdown can wait for them (a wake they return is kept, not lost). */
	const inflight = new Map<Promise<void>, number>(); // each running gate, and when it must have finished
	let closing = false;
	/** Loops that came due while the session was busy, and since when; they fire once it is free. */
	const waited = new Map<string, number>();
	/** Counts runs the session started; a gate's wake is used only if none started while it ran. */
	let activity = 0;
	/** The declaring files as last read (path -> mtime), so unchanged ones aren't re-read every tick. */
	let declaredSeen: string | undefined;
	const declaredErrors = new Map<string, string>();
	let gateLog = "";

	const zoneOf = (l: Loop) => l.tz ?? zone.tz;
	const nextFor = (l: Loop, from: number) => nextAtFor(l.schedule, from, l.createdAt, zoneOf(l));
	const when = (l: Loop) => fmtTime(l.nextAt, zoneOf(l));
	/** Loops whose fire times depend on a zone: daily `at` and whole-day intervals (1d, 7d). */
	const zoned = (sch: Schedule) => sch.kind === "at" || sch.ms % 86_400_000 === 0;
	const desc = (l: Loop) => describe(l.schedule, zoned(l.schedule) ? zoneOf(l) : undefined);
	/** The loop's folder: where its gate, prompt template and state live. Checked inside the project at each use. */
	const home = (l: Loop) => {
		if (!l.dir) return ctx!.cwd;
		const dir = insideDir(ctx!.cwd, l.dir);
		if (!dir) throw new Error(`dir ${l.dir} is not a folder inside the project`);
		return path.join(fs.realpathSync(ctx!.cwd), dir);
	};
	const stateDirOf = (l: Loop) => path.join(home(l), ".pi", "loop-state", l.id);
	/** Busy: a run, compaction or queued prompt, or a loop turn of ours not finished yet. */
	const busy = () => { try { return !ctx!.isIdle() || !!ctx!.hasPendingMessages?.() || !!phase; } catch { return true; } };

	/**
	 * Re-derive future zoned fire times (`at`, whole-day intervals) from the current zone, so a changed
	 * loop.timezone (or loops written before zones existed) takes effect on
	 * load. Past-due times are left alone: they are catch-ups.
	 */
	function reconcile() {
		const now = Date.now();
		let changed = false;
		for (const l of loops) {
			if (l.paused || !zoned(l.schedule) || l.nextAt <= now) continue;
			const next = nextFor(l, now);
			if (next !== l.nextAt) { l.nextAt = next; changed = true; }
		}
		if (changed) save();
	}

	/** Pick up an edited loop.timezone without a restart. */
	function refreshZone() {
		if (!ctx) return;
		const before = zone.tz;
		zone = configuredZone(ctx.cwd);
		if (zone.tz !== before && !readOnly) { reconcile(); refreshStatus(); }
	}

	function load(): Loop[] {
		try { return JSON.parse(fs.readFileSync(file, "utf8")) as Loop[]; } catch { return []; }
	}
	function save() {
		// Only the owner writes. If the lock went away (its helper died), stop at once: another session may own it now.
		if (!holding()) return;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(loops, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, file);
	}
	/** One owner per project: an OS-held lock (lock.ts). Taking it is asynchronous; until then this session is read-only. */
	let folderLock: FolderLock | undefined;
	function claimLock(then: () => void) {
		const l = folderLock;
		if (!l) return;
		void l.claim().then(ok => {
			if (!ok || l !== folderLock || !ctx) {
				if (!lockAvailable() && !lockWarned) { lockWarned = true; notify("pi-loop needs perl (in the base system on macOS and most Linux) for its lock; without it this session can't run loops", "warning"); }
				return;
			}
			readOnly = false;
			then();
		});
	}
	let lockWarned = false;
	function releaseLock() { folderLock?.release(); }
	/** This session owns the loops right now; if it has just lost the lock, it becomes read-only. */
	function holding(): boolean {
		if (readOnly) return false;
		if (folderLock?.mine()) return true;
		lostLock();
		return false;
	}
	function lostLock() {
		if (readOnly) return;
		readOnly = true;
		notify("pi-loop lost its lock on this folder's loops; this session is read-only until it can take it back", "warning");
		refreshStatus();
	}
	function ownerPid(): string { return String(folderLock?.owner()?.pid ?? "?"); }


	// -------------------------------------------------------------- display --

	function refreshStatus() {
		if (!ctx) return;
		const active = loops.filter(l => !l.paused);
		if (!loops.length) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			if (herdrPane && !readOnly) herdr.clear();
			return;
		}
		if (readOnly) { ctx.ui.setStatus(STATUS_KEY, `loops: ${loops.length} (owned by pid ${ownerPid()})`); return; }
		const now = Date.now();
		if (herdrPane) herdr.update(loopTokens(loops, now, phase), now);
		const waiting = waited.size ? ` \u00b7 ${waited.size} waiting` : "";
		if (phase) { ctx.ui.setStatus(STATUS_KEY, `loops: ${active.length} \u00b7 ${phase.id} ${phase.state}${waiting}`); return; }
		if (waited.size) { ctx.ui.setStatus(STATUS_KEY, `loops: ${active.length}${waiting} for this session to be free`); return; }
		const next = active.slice().sort((a, b) => a.nextAt - b.nextAt)[0];
		ctx.ui.setStatus(STATUS_KEY, next
			? `loops: ${active.length}${loops.length > active.length ? ` (+${loops.length - active.length} paused)` : ""} · next ${next.id} ${when(next)} (in ${countdown(Math.max(0, next.nextAt - now))})`
			: `loops: ${loops.length} paused`);
	}

	function listText(): string {
		const zoneLine = `default zone ${zone.tz} (${zone.source === "system" ? "system" : `loop.timezone in ${zone.source}`})`;
		if (!loops.length) return `No loops. /loop [10m|2h|1d|at HH:MM [Area/City]] <prompt>\n${zoneLine}`;
		const head = readOnly ? `(read-only: loops owned by pid ${ownerPid()})\n` : "";
		return head + loops.map(l => {
			const state = l.paused ? "paused" : `next ${when(l)}`;
			const p = l.prompt.length > 70 ? `${l.prompt.slice(0, 67)}…` : l.prompt;
			const extra = [l.dir ? `folder ${l.dir}/` : "", l.priority ? `priority ${l.priority}` : "", l.source ? `declared in ${l.source}` : "", waited.has(l.id) ? "waiting for this session to be free" : ""].filter(Boolean);
			return `${l.id}  ${desc(l)}  ${state}  ×${l.fires}\n    ${p}${extra.length ? `\n    ${extra.join(" · ")}` : ""}${l.gate ? `\n    ${gateText(l)}` : ""}`;
		}).join("\n") + `\n${zoneLine}`;
	}

	function gateText(l: Loop): string {
		const g = l.gate!;
		const sleep = g.maxSleepMs ? `, max sleep ${countdown(g.maxSleepMs)}` : "";
		const last = l.lastGate ? ` · last ${l.lastGate.action} ${countdown(Math.max(0, Date.now() - l.lastGate.at))} ago: ${l.lastGate.reason}` : "";
		const errs = l.gateErrors ? ` · ${l.gateErrors} error${l.gateErrors === 1 ? "" : "s"} in a row` : "";
		const onErr = g.onError === "skip" ? ", on error skip" : "";
		return `gate ${g.command}${sleep}${onErr} · ${l.gateRuns ?? 0} runs${errs}${last}`;
	}

	function notify(msg: string, level: "info" | "warning" | "error" = "info") {
		try { ctx?.ui.notify(msg, level); } catch { /* no UI in print/json mode */ }
	}

	// -------------------------------------------------------------- actions --

	function add(schedule: Schedule, prompt: string, id?: string, tz?: string, gate?: GateConfig, more: Pick<Loop, "priority" | "dir" | "context"> = {}): Loop | string {
		if (readOnly) return `loops are owned by pid ${ownerPid()}; manage them from that session`;
		if (tz && !zoned(schedule)) return "a time zone applies only to `at` loops and whole-day intervals (1d, 7d)";
		const base = id?.trim() || slug(prompt);
		let unique = base;
		for (let n = 2; loops.some(l => l.id === unique); n++) unique = `${base}-${n}`;
		const now = Date.now();
		const loop: Loop = {
			id: unique, prompt, schedule, paused: false, createdAt: now, fires: 0,
			catchUp: schedule.kind === "at" || schedule.ms >= CATCH_UP_MIN_MS ? "latest" : "none",
			nextAt: 0,
			...(tz ? { tz } : {}),
			...(gate ? { gate } : {}),
			...(more.priority ? { priority: more.priority } : {}),
			...(more.dir ? { dir: more.dir } : {}),
			...(more.context?.length ? { context: more.context } : {}),
		};
		loop.nextAt = nextFor(loop, now);
		loops.push(loop);
		save();
		refreshStatus();
		return loop;
	}

	function find(id: string): Loop | undefined {
		return loops.find(l => l.id === id) ?? loops.find(l => l.id.startsWith(id));
	}

	function remove(id: string): string {
		if (readOnly) return `loops are owned by pid ${ownerPid()}`;
		const l = find(id);
		if (!l) return `no loop "${id}"`;
		if (l.source) return `${l.id} is declared in ${l.source}; remove it there (or pause it)`;
		loops = loops.filter(x => x !== l);
		save(); refreshStatus();
		return `removed ${l.id}`;
	}

	function setPaused(id: string, paused: boolean): string {
		if (readOnly) return `loops are owned by pid ${ownerPid()}`;
		const l = find(id);
		if (!l) return `no loop "${id}"`;
		l.paused = paused;
		if (!paused) l.nextAt = nextFor(l, Date.now());
		save(); refreshStatus();
		return paused ? `paused ${l.id}` : `resumed ${l.id}; next ${when(l)}`;
	}

	function setGate(id: string, gate: GateConfig | undefined): string {
		if (readOnly) return `loops are owned by pid ${ownerPid()}`;
		const l = find(id);
		if (!l) return `no loop "${id}"`;
		if (l.source) return `${l.id} is declared in ${l.source}; change its gate there`;
		if (gate) l.gate = gate; else delete l.gate;
		l.rev = (l.rev ?? 0) + 1;
		save(); refreshStatus();
		return gate ? `${l.id}: ${gateText(l)}` : `${l.id}: gate removed; every fire wakes the model`;
	}

	/** Run the gate once and report its decision; never wakes the model or changes the schedule. */
	async function testGate(id: string, caller?: ExtensionContext): Promise<string> {
		const l = find(id);
		if (!l) return `no loop "${id}"`;
		if (!l.gate) return `${l.id} has no gate`;
		const t0 = Date.now();
		const session = sessionOf(caller?.sessionManager ? caller : ctx);
		let where: string;
		try { where = home(l); } catch (e) { return `${l.id}: ${(e as Error).message}`; }
		const d = await runGate(where, l.gate, { id: l.id, prompt: l.prompt, lastWokeAt: l.lastWokeAt, stateDir: path.join(where, ".pi", "loop-state", l.id), test: true, session });
		const extra = d.action === "defer" ? ` (retry in ${countdown(d.retryInMs ?? 0)})` : "";
		return `${l.id} gate (test, no wake) -> ${d.action}${extra} in ${Date.now() - t0}ms: ${d.reason}${d.context ? `\n${d.context}` : ""}`;
	}

	/**
	 * Run a gated loop's gate, then wake, skip or defer. Runs only while the session is free.
	 * The loop is rescheduled first so it is not due twice. A wake that comes back while the
	 * session is busy (or was busy meanwhile, or is shutting down) is kept as pendingWake and sent
	 * once the session is free, without running the gate again.
	 */
	function gateThen(l: Loop, reason: Reason) {
		const started = Date.now();
		const rev = l.rev ?? 0, act = activity;
		l.nextAt = nextFor(l, started);
		gating.add(l.id);
		save();
		let run: Promise<GateDecision>;
		try { run = runGate(home(l), l.gate!, { id: l.id, prompt: l.prompt, lastWokeAt: l.lastWokeAt, stateDir: stateDirOf(l), session: sessionOf(ctx) }); }
		catch (e) { run = Promise.resolve({ action: l.gate!.onError, reason: `gate error: ${(e as Error).message}`, error: true }); }
		const done = run
			.catch((e): GateDecision => ({ action: l.gate!.onError, reason: `gate error: ${(e as Error)?.message ?? e}`, error: true }))
			.then(raw => {
				gating.delete(l.id);
				if (!ctx || readOnly || !loops.includes(l)) return;
				// The loop was redefined while its gate ran: this answer is about the old one. Its schedule stands.
				if ((l.rev ?? 0) !== rev) { refreshStatus(); return; }
				// The session is busy, worked while the gate ran, or is shutting down: keep the wake and send
				// it once free. Gates may record what they reported, so running this one again could lose it.
				if (raw.action === "wake" && !l.paused && (closing || busy() || activity !== act)) {
					const d = backoff(l, raw, Date.now());
					l.gateRuns = (l.gateRuns ?? 0) + 1;
					l.lastGate = { at: Date.now(), action: d.action, reason: d.reason };
					logDecision(gateLog, { ts: new Date().toISOString(), id: l.id, action: d.action, reason: d.reason, ms: Date.now() - started, ...(d.error ? { error: true } : {}) });
					if (d.action === "wake") {
						l.pendingWake = { reason: d.reason, ...(d.context ? { context: d.context } : {}), at: started, rev };
						waited.set(l.id, waited.get(l.id) ?? started);
					}
					save(); refreshStatus(); return;
				}
				if (raw.action !== "wake") waited.delete(l.id);
				const d = backoff(l, raw, Date.now());
				l.gateRuns = (l.gateRuns ?? 0) + 1;
				l.lastGate = { at: Date.now(), action: d.action, reason: d.reason };
				logDecision(gateLog, { ts: new Date().toISOString(), id: l.id, action: d.action, reason: d.reason, ms: Date.now() - started, ...(d.error ? { error: true } : {}) });
				if (d.action === "defer") l.nextAt = Math.min(Date.now() + (d.retryInMs ?? 60_000), l.nextAt);
				if (d.action === "wake" && !l.paused) { fire(l, reason, d); return; }
				waited.delete(l.id); // the occurrence was handled (skipped, deferred, or a quiet gate error)
				save(); refreshStatus();
			});
		inflight.set(done, started + (l.gate!.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS));
		void done.finally(() => inflight.delete(done));
	}

	/**
	 * A failing gate wakes the model once, then stays quiet while it keeps failing,
	 * with a reminder wake every GATE_ERROR_REWAKE_MS; a successful run resets it.
	 * Without this, a broken gate on a 2-minute loop would wake the model every 2 minutes.
	 */
	function backoff(l: Loop, d: GateDecision, now: number): GateDecision {
		if (!d.error) {
			delete l.gateErrors; delete l.gateErrorWokeAt;
			return d;
		}
		l.gateErrors = (l.gateErrors ?? 0) + 1;
		if (d.action !== "wake") return d;
		const woke = l.gateErrorWokeAt;
		if (l.gateErrors > 1 && woke !== undefined && now - woke < GATE_ERROR_REWAKE_MS) {
			return { ...d, action: "skip", reason: `${d.reason} (${l.gateErrors} errors in a row; woke for it ${countdown(now - woke)} ago, next reminder in ${countdown(GATE_ERROR_REWAKE_MS - (now - woke))})` };
		}
		l.gateErrorWokeAt = now;
		return l.gateErrors > 1 ? { ...d, reason: `${d.reason} (still failing: ${l.gateErrors} errors in a row)` } : d;
	}

	function fire(l: Loop, reason: Reason, gate?: GateDecision): string | undefined {
		if (!holding()) return `loops are owned by pid ${ownerPid()}`;
		try { home(l); } catch (e) { const msg = `loop ${l.id}: ${(e as Error).message}; not fired`; notify(msg, "warning"); return msg; }
		// The occurrence is recorded as sent only after it is handed over (below): a crash in between
		// sends it again with the same fire number, which a host recognises as the same occurrence.
		const before = { fires: l.fires, lastFiredAt: l.lastFiredAt, lastWokeAt: l.lastWokeAt, nextAt: l.nextAt, pendingWake: l.pendingWake, waited: waited.get(l.id) };
		l.fires += 1;
		l.lastFiredAt = Date.now();
		l.lastWokeAt = l.lastFiredAt;
		// A manual run of a loop that is due (or waiting) is that occurrence; a manual run ahead of time isn't.
		if (reason !== "manual" || l.nextAt <= Date.now()) l.nextAt = nextFor(l, Date.now());
		// One line: a gate's reason may hold newlines (a JSON "\n"), and readers of the header
		// (the model, and any extension that recognises loop turns) take it to end at the line's closing "]".
		const why = gate ? ` · gate: ${gate.reason.replace(/\s*[\r\n]+\s*/g, " ").trim()}` : "";
		const header = `[loop ${l.id} · ${desc(l)} · fire #${l.fires}${reason === "due" ? "" : ` · ${reason}`}${why}]`;
		const evidence = gate?.context ? `\n\n<gate-context>\n${gate.context}\n</gate-context>` : "";
		const where = loopContext(l);
		// A prompt template is expanded here from its file (fresh each fire), so the
		// header and gate context survive intact; see prompt.ts.
		let commands: CommandInfo[] = [];
		try { commands = (pi as any).getCommands?.() ?? []; } catch { /* older Pi */ }
		const { text, expand } = compose(l.prompt, header + where, evidence, home(l), commands, !!l.dir);
		try {
			// `loop` names the occurrence for a host (Pi ignores it): the same id and fire mean the same turn.
			pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: expand, loop: { id: l.id, fire: l.fires, rev: l.rev ?? 0, since: l.createdAt } } as any);
		} catch (e) {
			Object.assign(l, { fires: before.fires, lastFiredAt: before.lastFiredAt, lastWokeAt: before.lastWokeAt, nextAt: before.nextAt });
			// A gate may have recorded that it reported this: keep its wake rather than ask it again.
			if (gate) { l.pendingWake = { reason: gate.reason, ...(gate.context ? { context: gate.context } : {}), at: Date.now(), rev: l.rev ?? 0 }; save(); }
			const msg = `loop ${l.id}: couldn't send its turn (${(e as Error).message}); it is kept and sent again`;
			notify(msg, "warning"); refreshStatus();
			return msg;
		}
		waited.delete(l.id);
		delete l.pendingWake;
		phase = { state: "queued", id: l.id };
		phaseAt = Date.now();
		save();
		refreshStatus();
	}

	/** What a loop with a folder adds after its header: the folder, and its context files. */
	function loopContext(l: Loop): string {
		if (!l.dir && !l.context?.length) return "";
		let out = l.dir ? `\nThis loop's folder is ${l.dir}/ in the project; paths in its instructions are relative to it.` : "";
		let left = MAX_LOOP_CONTEXT_CHARS;
		for (const f of l.context ?? []) {
			const rel = path.join(l.dir ?? "", f);
			let body: string;
			try {
				const abs = fs.realpathSync(path.join(home(l), f));
				const root = fs.realpathSync(ctx!.cwd);
				if (!abs.startsWith(root + path.sep)) throw new Error("outside");
				body = fs.readFileSync(abs, "utf8").trim();
			} catch { out += `\n<loop-context file="${rel}">(could not be read)</loop-context>`; continue; }
			if (body.length > left) body = `${body.slice(0, Math.max(0, left))}\n…[truncated]`;
			left -= body.length;
			out += `\n<loop-context file="${rel}">\n${body}\n</loop-context>`;
		}
		return out;
	}

	// ------------------------------------------------------- declared loops --

	/** .pi/loop.json in the project and in each folder directly under it (not hidden ones or node_modules). */
	function declaringFiles(): string[] {
		const cwd = ctx!.cwd;
		const out: string[] = [];
		const at = (dir: string) => { const f = path.join(dir, ".pi", "loop.json"); if (fs.existsSync(f)) out.push(f); };
		at(cwd);
		// A host (a scheduler that embeds this extension for one folder) serves only that folder's loops.
		if (ctx!.mode === "host") return out;
		let entries: fs.Dirent[] = [];
		try { entries = fs.readdirSync(cwd, { withFileTypes: true }); } catch { /* unreadable */ }
		for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") at(path.join(cwd, e.name));
		return out.sort();
	}

	/** Bring loops in line with the .pi/loop.json files: add, update and remove declared loops; keep run state. */
	function syncDeclared() {
		if (!ctx || readOnly) return;
		const files = declaringFiles();
		const stamp = files.map(f => { try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch { return f; } }).join("|");
		if (stamp === declaredSeen) return;
		declaredSeen = stamp;
		const cwd = ctx.cwd;
		const seen = new Set<string>();
		const broken = new Set<string>();
		let changed = false;
		// Which ids each file declares right now, so a loop moved from one file to another changes hands.
		const declaresNow = new Map<string, Set<string>>();
		for (const file of files) {
			try {
				const raw = JSON.parse(fs.readFileSync(file, "utf8"));
				const list = Array.isArray(raw) ? raw : raw?.loops;
				if (Array.isArray(list)) declaresNow.set(path.relative(cwd, file), new Set(list.map((d: any) => d?.id).filter((x: unknown) => typeof x === "string")));
			} catch { declaresNow.set(path.relative(cwd, file), new Set(["*"])); /* unreadable: treat as still declaring all it did */ }
		}
		const stillDeclares = (source: string, id: string) => { const ids = declaresNow.get(source); return !!ids && (ids.has(id) || ids.has("*")); };
		for (const file of files) {
			const source = path.relative(cwd, file);
			const folder = path.dirname(path.dirname(file));
			let decls: Declared[];
			try {
				const raw = JSON.parse(fs.readFileSync(file, "utf8"));
				decls = Array.isArray(raw) ? raw : raw?.loops;
				if (!Array.isArray(decls)) throw new Error("expected a list of loops, or {\"loops\": [...]}");
			} catch (e) {
				broken.add(source);
				const msg = `${source}: ${(e as Error).message}; its loops are left as they were`;
				if (declaredErrors.get(source) !== msg) { declaredErrors.set(source, msg); notify(msg, "warning"); }
				continue;
			}
			declaredErrors.delete(source);
			for (const d of decls) {
				let def: ReturnType<typeof fromDeclared>;
				try { def = fromDeclared(d, folder); } catch (e) {
					const msg = `${source}: loop ${JSON.stringify(d?.id ?? "?")}: ${(e as Error).message}`;
					if (declaredErrors.get(`${source}#${d?.id}`) !== msg) { declaredErrors.set(`${source}#${d?.id}`, msg); notify(msg, "warning"); }
					broken.add(source);
					if (typeof d?.id === "string") seen.add(d.id);
					continue;
				}
				if (seen.has(def.id)) { notify(`${source}: loop id ${def.id} is declared twice; the first wins`, "warning"); continue; }
				const l = loops.find(x => x.id === def.id);
				// Its old file no longer declares it (it moved here): this file takes it over, run state and all.
				if (l && l.source && l.source !== source && !stillDeclares(l.source, def.id)) {
					l.source = source; changed = true;
				}
				if (l && l.source !== source) {
					// Never take over a loop made with loop_manage, or one another file declares.
					const msg = `${source}: loop id ${def.id} is already ${l.source ? `declared in ${l.source}` : "a loop made with loop_manage"}; rename one`;
					if (declaredErrors.get(`${source}#${def.id}`) !== msg) { declaredErrors.set(`${source}#${def.id}`, msg); notify(msg, "warning"); }
					continue;
				}
				seen.add(def.id);
				const declaredPaused = !!d.paused;
				if (!l) {
					const now = Date.now();
					const loop: Loop = { ...def, source, paused: declaredPaused, declaredPaused, rev: 1, createdAt: now, fires: 0, nextAt: 0,
						catchUp: def.schedule.kind === "at" || def.schedule.ms >= CATCH_UP_MIN_MS ? "latest" : "none" };
					loop.nextAt = nextFor(loop, now);
					loops.push(loop); changed = true;
					continue;
				}
				const defOf = (x: Loop) => JSON.stringify([x.prompt, x.schedule, x.tz, x.gate, x.priority, x.dir, x.context]);
				const before = defOf(l);
				const reschedule = JSON.stringify(l.schedule) !== JSON.stringify(def.schedule) || l.tz !== def.tz;
				Object.assign(l, def);
				for (const k of ["tz", "gate", "priority", "dir", "context"] as const) if ((def as any)[k] === undefined) delete (l as any)[k];
				l.catchUp = l.schedule.kind === "at" || l.schedule.ms >= CATCH_UP_MIN_MS ? "latest" : "none";
				// Only a change to the declared `paused` pauses or resumes; /loop pause and resume hold otherwise.
				if (l.declaredPaused !== declaredPaused) {
					l.declaredPaused = declaredPaused; changed = true;
					if (l.paused !== declaredPaused) { l.paused = declaredPaused; if (!l.paused) l.nextAt = nextFor(l, Date.now()); }
				}
				if (reschedule) l.nextAt = nextFor(l, Date.now());
				if (defOf(l) !== before) { l.rev = (l.rev ?? 0) + 1; waited.delete(l.id); changed = true; }
			}
		}
		// A declared loop whose file no longer declares it is gone; one in a broken file is kept as it was.
		const kept = loops.filter(l => !l.source || seen.has(l.id) || broken.has(l.source));
		if (kept.length !== loops.length) { loops = kept; changed = true; }
		if (changed) { save(); refreshStatus(); }
	}

	function fromDeclared(d: Declared, folder: string): Pick<Loop, "id" | "prompt" | "schedule" | "tz" | "gate" | "priority" | "dir" | "context"> {
		if (!d || typeof d !== "object") throw new Error("not an object");
		if (typeof d.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(d.id)) throw new Error("id: letters, digits, . _ -");
		if (typeof d.prompt !== "string" || !d.prompt.trim()) throw new Error("prompt is required");
		if (d.every && d.at) throw new Error("use either every or at");
		let schedule: Schedule;
		if (d.at) { const a = parseAt(d.at); if (!a) throw new Error("at must be HH:MM"); schedule = { kind: "at", ...a }; }
		else {
			const ms = d.every ? parseInterval(d.every) : DEFAULT_INTERVAL_MS;
			if (ms === undefined) throw new Error("every must look like 5m, 2h or 1d");
			if (ms < MIN_INTERVAL_MS) throw new Error("minimum interval is 1m");
			schedule = { kind: "every", ms };
		}
		const tz = d.timezone ? validZone(d.timezone) : undefined;
		if (d.timezone && !tz) throw new Error(`unknown time zone "${d.timezone}"`);
		if (tz && !zoned(schedule)) throw new Error("a time zone applies only to at loops and whole-day intervals");
		const dir = insideDir(ctx!.cwd, path.relative(ctx!.cwd, folder) || undefined);
		const gate = d.gate ? gateConfig({ gate: d.gate, maxSleep: d.maxSleep, gateTimeout: d.gateTimeout, gateOnError: d.gateOnError }, dir) : undefined;
		if (d.priority !== undefined && !Number.isFinite(d.priority)) throw new Error("priority must be a number");
		const context = contextFiles(d.context);
		return { id: d.id, prompt: d.prompt.trim(), schedule, ...(tz ? { tz } : {}), ...(gate ? { gate } : {}),
			...(d.priority ? { priority: d.priority } : {}), ...(dir ? { dir } : {}), ...(context ? { context } : {}) };
	}

	function contextFiles(v: unknown): string[] | undefined {
		if (v === undefined) return undefined;
		const list = typeof v === "string" ? [v] : v;
		if (!Array.isArray(list) || list.some(f => typeof f !== "string" || !f.trim() || path.isAbsolute(f) || f.split(/[\\/]/).includes(".."))) throw new Error("context: file paths inside the loop's folder");
		return list.length ? list.map(f => f.trim()) : undefined;
	}

	type Reason = "due" | "catch-up" | "manual" | `waited ${string}`;

	function tick() {
		if (!ctx) return;
		if (readOnly) {
			claimLock(() => { loops = load(); declaredSeen = undefined; syncDeclared(); reconcile(); refreshStatus(); });
			return;
		}
		const now = Date.now();
		// One loop per tick: a burst after sleep should not queue five turns at once.
		// A fired prompt that never reached the transcript (dropped queue) must not read "queued" forever.
		if (phase?.state === "queued" && now - phaseAt > 2 * TICK_MS && ctx.isIdle?.() && !ctx.hasPendingMessages?.()) phase = undefined;
		syncDeclared();
		for (const id of waited.keys()) if (!loops.some(l => l.id === id && !l.paused)) waited.delete(id);
		// A kept wake whose loop was redefined since is about the old definition: drop it.
		for (const l of loops) if (l.pendingWake && l.pendingWake.rev !== (l.rev ?? 0)) { delete l.pendingWake; save(); }
		const dueNow = loops.filter(l => !l.paused && !gating.has(l.id) && (l.nextAt <= now || l.pendingWake));
		if (!dueNow.length) { refreshStatus(); return; }
		// Busy: due loops wait, once each, for the session to be free; nothing is queued behind the turn.
		if (busy() || gating.size) {
			for (const l of dueNow) if (!waited.has(l.id)) waited.set(l.id, now);
			refreshStatus();
			return;
		}
		// Free: the highest priority goes first, then the longest overdue.
		const due = dueNow.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.nextAt - b.nextAt)[0];
		try { home(due); } catch (e) {
			// Its folder is gone or outside the project: skip this occurrence, say so, keep the others running.
			notify(`loop ${due.id}: ${(e as Error).message}; skipped`, "warning");
			logDecision(gateLog, { ts: new Date(now).toISOString(), id: due.id, action: "skip", reason: (e as Error).message, ms: 0, error: true });
			waited.delete(due.id); due.nextAt = nextFor(due, now); save(); refreshStatus();
			return;
		}
		const since = waited.get(due.id) ?? due.pendingWake?.at;
		if (due.pendingWake) {
			const w = due.pendingWake;
			fire(due, `waited ${countdown(Math.max(0, now - w.at))}`, { action: "wake", reason: w.reason, ...(w.context ? { context: w.context } : {}) });
			return;
		}
		if (since === undefined && now - due.nextAt > TICK_MS * 4 && due.catchUp === "none") {
			// Missed by more than a minute with no session to run it (sleep, restart): short loops just realign.
			due.nextAt = nextFor(due, now);
			save(); refreshStatus();
			return;
		}
		const reason: Reason = since !== undefined ? `waited ${countdown(Math.max(0, now - Math.min(since, due.nextAt)))}` : now - due.nextAt > TICK_MS * 4 ? "catch-up" : "due";
		if (!due.gate) { fire(due, reason); return; }
		const g = due.gate;
		if (g.maxSleepMs && now - (due.lastWokeAt ?? due.createdAt) >= g.maxSleepMs) {
			const d: GateDecision = { action: "wake", reason: `max sleep ${countdown(g.maxSleepMs)} reached; gate not consulted` };
			due.lastGate = { at: now, action: "wake", reason: d.reason };
			logDecision(gateLog, { ts: new Date(now).toISOString(), id: due.id, action: "wake", reason: d.reason, ms: 0 });
			fire(due, reason, d);
			return;
		}
		gateThen(due, reason);
	}

	// ------------------------------------------------------------ lifecycle --

	pi.on("session_start", (_event, c) => {
		ctx = c;
		file = path.join(c.cwd, ".pi", "loops.json");
		lock = path.join(c.cwd, ".pi", "loops.lock");
		gateLog = path.join(c.cwd, ".pi", "loops.log.jsonl");
		gating.clear();
		zone = configuredZone(c.cwd);
		if (zone.warning) notify(zone.warning, "warning");
		loops = load();
		waited.clear(); declaredSeen = undefined; declaredErrors.clear();
		folderLock?.release();
		folderLock = new FolderLock(lock, {}, () => lostLock());
		readOnly = true;
		claimLock(() => { loops = load(); syncDeclared(); reconcile(); refreshStatus(); });
		if (timer) clearInterval(timer);
		timer = setInterval(tick, TICK_MS);
		// Headless modes have no pane to decorate (same gate as Herdr's Pi integration).
		herdrPane = c.mode === "tui" && herdr.enabled;
		phase = undefined;
		refreshStatus();
	});

	// queued -> running when the loop's own message enters the transcript; done when Pi settles.
	pi.on("message_start", (event) => {
		if (phase?.state !== "queued") return;
		const m = event.message as { role?: string; content?: unknown };
		if (m.role !== "user") return;
		const text = typeof m.content === "string" ? m.content
			: Array.isArray(m.content) ? m.content.map(c => (c as { text?: string }).text ?? "").join("") : "";
		if (!text.includes(`[loop ${phase.id} \u00b7`)) return;
		phase = { state: "running", id: phase.id };
		refreshStatus();
	});

	// A run started: a gate that was running when it did may have looked at stale facts.
	pi.on("agent_start", () => { activity++; });

	// The loop's turn is over once Pi settles, even if a compaction starts right after: busy() still
	// sees the compaction through isIdle(), and Pi sends no second agent_settled when it ends.
	pi.on("agent_settled", () => {
		if (phase?.state !== "running") return;
		phase = undefined;
		refreshStatus();
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		// Let running gates finish (up to their own timeout), so a wake they return is kept for the
		// next owner instead of lost; a gate may already have recorded that it reported it.
		closing = true;
		if (inflight.size && !readOnly) {
			// Each gate is bounded by its own timeout from when it started (runGate kills it then).
			const until = Math.max(...inflight.values()) + 2000;
			await Promise.race([Promise.allSettled([...inflight.keys()]), new Promise(r => setTimeout(r, Math.max(0, until - Date.now())))]);
		}
		closing = false;
		if (herdrPane && !readOnly) herdr.clear();
		releaseLock();
		folderLock = undefined;
		ctx = undefined;
	});

	// -------------------------------------------------------------- command --

	pi.registerCommand("loop", {
		description: "Recurring prompt in this session: /loop [10m|2h|1d|at HH:MM [Area/City]] <prompt> · /loop · /loop rm|pause|resume|run|test <id> · /loop clear",
		handler: async (args: string, commandCtx?: ExtensionContext) => {
			refreshZone();
			const trimmed = args.trim();
			if (!trimmed || trimmed === "list") { notify(listText()); return; }
			if (trimmed === "clear") {
				if (readOnly) { notify(`loops are owned by pid ${ownerPid()}`, "warning"); return; }
				const keep = loops.filter(l => l.source);
				const n = loops.length - keep.length; loops = keep; save(); refreshStatus();
				notify(`removed ${n} loop${n === 1 ? "" : "s"}${keep.length ? `; ${keep.length} declared in .pi/loop.json files kept (edit them there)` : ""}`); return;
			}
			const [verb, target, ...more] = trimmed.split(/\s+/);
			// Subcommands only when the target names an existing loop; otherwise
			// "/loop run the tests" is a prompt, as in Claude Code.
			if (target && more.length === 0 && find(target)) {
				switch (verb) {
					case "rm": case "stop": case "delete": case "remove": notify(remove(target)); return;
					case "pause": notify(setPaused(target, true)); return;
					case "resume": notify(setPaused(target, false)); return;
					case "test": notify(await testGate(target, commandCtx)); return;
					case "run": case "now": {
						if (readOnly) { notify(`loops are owned by pid ${ownerPid()}`, "warning"); return; }
						const l = find(target)!; const err = fire(l, "manual"); if (!err) notify(`fired ${l.id}`); return;
					}
				}
			}
			const parsed = parseAdd(trimmed);
			if ("error" in parsed) { notify(parsed.error, "warning"); return; }
			const r = add(parsed.schedule, parsed.prompt, undefined, parsed.tz);
			if (typeof r === "string") { notify(r, "warning"); return; }
			notify(`loop ${r.id}: ${desc(r)}, next ${when(r)}. /loop rm ${r.id} to stop.`);
		},
	});

	// ----------------------------------------------------------------- tool --

	function gateConfig(p: { gate?: string; maxSleep?: string; gateTimeout?: string; gateOnError?: string }, dir?: string): GateConfig {
		const command = p.gate!.trim();
		const r = resolveGate(dir ? path.join(ctx!.cwd, dir) : ctx!.cwd, command);
		if ("error" in r) throw new Error(r.error);
		if (p.gateOnError && p.gateOnError !== "wake" && p.gateOnError !== "skip") throw new Error("gateOnError must be wake or skip");
		const cfg: GateConfig = { command, timeoutMs: DEFAULT_GATE_TIMEOUT_MS, onError: p.gateOnError === "skip" ? "skip" : "wake" };
		if (p.maxSleep) {
			const ms = parseInterval(p.maxSleep);
			if (ms === undefined) throw new Error("maxSleep must look like 6h or 1d");
			cfg.maxSleepMs = ms;
		}
		if (p.gateTimeout) {
			const ms = parseInterval(p.gateTimeout) ?? (/^\d+s$/.test(p.gateTimeout) ? Number(p.gateTimeout.slice(0, -1)) * 1000 : undefined);
			if (ms === undefined) throw new Error("gateTimeout must look like 90s or 2m");
			cfg.timeoutMs = ms;
		}
		return cfg;
	}

	pi.registerTool({
		name: "loop_manage",
		label: "Manage loops",
		description:
			"Recurring prompts (loops) in this session: create, list, delete, pause, resume, run (fire now), gate (set or remove a gate) " +
			"or test (run the gate once without waking). A loop re-sends its prompt to this same session on a schedule, and each fire is " +
			"a full model turn with this conversation as context. `every` is a fixed interval (default 10m); `at` is a daily HH:MM wall-clock " +
			"time that follows daylight saving in the loop's zone. A gate is a script in the project that runs when the loop is due and " +
			"prints JSON deciding skip, wake or defer, so a frequent check wakes the model only when needed. A due loop waits while the " +
			"session is busy and fires once when it is free (highest priority first), never stacking. A loop can have its own folder " +
			"(dir) holding its gate, prompt template and context files. Loops can also be declared in .pi/loop.json files (see the " +
			"pi-loop skill). Loops persist across restarts and fire only while a Pi session is open in this project.",
		promptSnippet: "Schedule recurring prompts in this session (/loop): create, list, delete, pause, resume, run, gate, test",
		promptGuidelines: [
			"Use loop_manage when the user wants something done periodically or daily in this session; reply with the loop id and next fire time. Run loop_manage list first and change an existing loop rather than adding a duplicate.",
			"For loop_manage loops, put the instructions in a prompt template (.pi/prompts/<name>.md) and make the loop prompt /<name>, saying where results go; a loop turn's output stays in this session otherwise.",
			"Give loop_manage loops that run more often than hourly a gate so most fires cost no model turn; read the pi-loop skill before writing a gate or a loop like that.",
			"loop_manage loops fire only while a Pi session is open here; for a run that must never be missed, suggest the system scheduler (cron, launchd, systemd) instead.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("create"), Type.Literal("list"), Type.Literal("delete"),
				Type.Literal("pause"), Type.Literal("resume"), Type.Literal("run"), Type.Literal("gate"), Type.Literal("test"),
			]),
			prompt: Type.Optional(Type.String({ description: "create: the prompt to re-send each time." })),
			every: Type.Optional(Type.String({ description: "create: fixed interval like 5m, 2h, 1d. Default 10m. Mutually exclusive with `at`." })),
			at: Type.Optional(Type.String({ description: "create: daily wall-clock time HH:MM in the loop's time zone." })),
			timezone: Type.Optional(Type.String({ description: "create with `at` or a whole-day `every` (1d, 7d): IANA zone such as Europe/Berlin or Asia/Tokyo. Omit to follow the configured default (loop.timezone, else the machine zone); ask the user for their zone rather than guessing." })),
			id: Type.Optional(Type.String({ description: "Loop id (or unique prefix). Optional custom id on create." })),
			gate: Type.Optional(Type.String({ description: "create or gate: executable inside the project (e.g. .pi/gates/check) run when the loop is due; it prints {action: skip|wake|defer, reason, context?, retryIn?} and only `wake` starts a model turn. With action gate, an empty string removes the gate." })),
			maxSleep: Type.Optional(Type.String({ description: "With gate: wake anyway once this long has passed since the last wake, e.g. 12h." })),
			gateTimeout: Type.Optional(Type.String({ description: "With gate: kill the gate after this long (default 60s, e.g. 2m); a timeout counts as a gate error, which wakes the model." })),
			gateOnError: Type.Optional(Type.String({ description: "With gate: what a gate error does, wake (default) or skip. A failing gate wakes once, then only every 6h until it succeeds again." })),
			priority: Type.Optional(Type.Number({ description: "create: when several loops wait for the session to be free, higher goes first (default 0)." })),
			dir: Type.Optional(Type.String({ description: "create: the loop's own folder inside the project (e.g. services/api). Its gate, prompt template (/name from <dir>/.pi/prompts) and state are found there." })),
			context: Type.Optional(Type.Array(Type.String(), { description: "create: files in the loop's folder attached to each of its turns, e.g. [\"AGENTS.md\"]." })),
		}),
		async execute(_toolCallId, p, _signal, _onUpdate, toolCtx) {
			refreshZone();
			if (p.action === "test") return { content: [{ type: "text", text: await testGate(p.id ?? "", toolCtx) }], details: { loops } };
			const text = (() => {
				switch (p.action) {
					case "list": return listText();
					case "delete": return remove(p.id ?? "");
					case "pause": return setPaused(p.id ?? "", true);
					case "resume": return setPaused(p.id ?? "", false);
					case "run": {
						if (readOnly) return `loops are owned by pid ${ownerPid()}`;
						const l = find(p.id ?? ""); if (!l) return `no loop "${p.id}"`;
						const err = fire(l, "manual"); if (err) throw new Error(err);
						return `fired ${l.id}; its prompt runs after this turn`;
					}
					case "gate": {
						if (!p.id) throw new Error("id is required");
						return setGate(p.id, p.gate?.trim() ? gateConfig(p, find(p.id)?.dir) : undefined);
					}
					case "create": {
						if (!p.prompt?.trim()) throw new Error("prompt is required");
						if (p.every && p.at) throw new Error("use either every or at");
						const tz = p.timezone ? validZone(p.timezone) : undefined;
						if (p.timezone && !tz) throw new Error(`unknown time zone "${p.timezone}"; use an IANA name like Europe/Berlin or Asia/Tokyo`);
						
						let schedule: Schedule;
						if (p.at) { const a = parseAt(p.at); if (!a) throw new Error("at must be HH:MM"); schedule = { kind: "at", ...a }; }
						else {
							const ms = p.every ? parseInterval(p.every) : DEFAULT_INTERVAL_MS;
							if (ms === undefined) throw new Error("every must look like 5m, 2h or 1d");
							if (ms < MIN_INTERVAL_MS) throw new Error("minimum interval is 1m");
							schedule = { kind: "every", ms };
						}
						const dir = insideDir(ctx!.cwd, p.dir?.trim());
						if (p.priority !== undefined && !Number.isFinite(p.priority)) throw new Error("priority must be a number");
						const r = add(schedule, p.prompt.trim(), p.id, tz, p.gate?.trim() ? gateConfig(p, dir) : undefined, { priority: p.priority, dir, context: contextFiles(p.context) });
						if (typeof r === "string") throw new Error(r);
						const hints: string[] = [];
						const twins = loops.filter(l => l !== r && l.prompt === r.prompt);
						if (twins.length) hints.push(`loop ${twins.map(l => l.id).join(", ")} already sends this prompt; delete one unless both are intended`);
						if (!r.gate && r.schedule.kind === "every" && r.schedule.ms < 3_600_000) hints.push("no gate: every fire is a full model turn; for a frequent check, add one with action gate (see the pi-loop skill)");
						if (!r.prompt.startsWith("/")) hints.push("tip: a prompt template (.pi/prompts/<name>.md, prompt /<name>) keeps the instructions editable between fires");
						return `created loop ${r.id}: ${desc(r)}, next fire ${when(r)}, catch-up ${r.catchUp}${r.gate ? `; ${gateText(r)}` : ""}${hints.map(h => `\n- ${h}`).join("")}`;
					}
				}
			})();
			return { content: [{ type: "text", text }], details: { loops } };
		},
	});
}
