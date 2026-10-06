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
	AD_HOC_LIFETIME_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, countdown, describe, fmtTime, nextAtFor, parseAt, parseInterval, validZone, systemZone,
	type Schedule,
} from "./schedule.ts";
import { fileURLToPath } from "node:url";
import { Run, RUN_MODES, extensionFlags, lastAssistantText, sessionFolder, transcriptOf, type Report, type RunMode, type RunRecord } from "./background.ts";
import { DEFAULT_GATE_TIMEOUT_MS, logDecision, resolveGate, runGate, type GateConfig, type GateDecision, type GateSession } from "./gate.ts";
import { compose, type CommandInfo } from "./prompt.ts";
import { FolderLock, lockAvailable } from "./lock.ts";
import { LoopsView, type LoopRow, type ViewAction } from "./view.ts";

type Phase = { state: "queued" | "running"; id: string } | undefined;

const STATUS_KEY = "loop";
/** What a loop run is asked to do at the end, so findings and pacing don't depend on its wording. */
const REPORT_HINT = "When you finish, call loop_report once: findings true only if there is something the owner should see " +
	"(false when all is as expected), a one-line summary, and optionally next (e.g. \"15m\") to choose when this loop runs again, or stop: true to end it.";
const TAKEOVER_NOTE = "[loop] The owner is taking over this conversation now. Stop here and reply with one line saying where you are.";
const CONTINUE_NOTE = "[loop] The owner stepped out. Carry on from where you are, and call loop_report when you are done.";
/** Longest a self-paced loop may put off its next run. */
const MAX_NEXT_MS = 7 * 24 * 60 * 60_000;

/** Process-wide: background runs and the folder lock outlive one extension instance (Pi rebuilds extensions on /new, /resume and session switches). */
interface Away { id: string; file: string; home: string; homeId?: string; fire: number; mode: RunMode; report: string; /** It was running when you went in (not just opened to read). */ live?: boolean }
interface Note { content: string; details: Record<string, unknown> }
/** What a finished run came to, collected before it is recorded. */
interface Outcome { status: RunRecord["status"]; summary: string; findings: boolean; rep?: Report }
interface Shared {
	lock?: FolderLock; lockPath?: string;
	/** Locks on the folders whose declared loops this session runs (role folders, adopted ones), by folder. */
	folderLocks?: Map<string, FolderLock>;
	runs: Map<string, Run>;
	/** Loops that came due while their previous run was still going: they run once more after it. */
	again: Set<string>;
	/** You are in this loop run's conversation (taken over); the main session waits. */
	away?: Away;
	/** You are on your way back from it: notes and turns wait until you are there. */
	leaving?: Away;
	/** Findings that came in while you were away, delivered when you are back. */
	notes: Note[];
	/** The live extension instance: finished runs report to it, whichever instance started them. */
	current?: Instance;
	/** Run events that came while no instance was live (Pi rebuilding extensions on a switch): the next one takes them. */
	pending: ((cur: Instance) => void | Promise<void>)[];
}
interface Instance {
	finishRun(id: string, run: Run, report: string): Promise<void>;
	recordRun(id: string, run: Run, outcome: Outcome): void;
	afterLeave(a: Away, finish: boolean): Promise<void>;
	runStarted(id: string, run: Run, note?: string): void;
	runFailed(id: string, run: Run, why: string, startedAt: number, gate?: GateDecision): void;
}
const shared: Shared = ((globalThis as any)[Symbol.for("pi-loop.shared")] ??= { runs: new Map(), again: new Set(), notes: [], pending: [] });
shared.pending ??= [];
/** Hand a run event to the live instance now, or to the next one. */
function live(fn: (cur: Instance) => void | Promise<void>) {
	if (shared.current) void fn(shared.current);
	else shared.pending.push(fn);
}

const catchUpOf = (s: Schedule): "latest" | "none" => s.kind !== "every" || s.ms >= CATCH_UP_MIN_MS ? "latest" : "none";
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
	/** Where its turn runs: in this conversation (absent), or in the background as a fork of it, its own thread, or fresh. */
	run?: RunMode;
	/** A background run's model, provider/id[:thinking]; absent = this session's. */
	model?: string;
	/** It ends then: ad hoc loops after 7 days unless they say otherwise; absent = never. */
	expiresAt?: number;
	/** Its latest background run. */
	lastRun?: RunRecord;
	/** Background runs that couldn't start in a row (retried soon, up to 3 times). */
	startFailures?: number;
}

/** Most text attached from context files to one turn. */
const MAX_LOOP_CONTEXT_CHARS = 64_000;
/** A declaration in a .pi/loop.json file. */
interface Declared {
	id: string; prompt: string; every?: string; at?: string; timezone?: string;
	gate?: string; maxSleep?: string; gateTimeout?: string; gateOnError?: string;
	priority?: number; context?: string[]; paused?: boolean;
	run?: string; for?: string; until?: string; model?: string;
}

// ------------------------------------------------------------ settings --

/** The cwd in a session file's header (its first line). */
function headerCwd(file: string): string | undefined {
	try {
		const fd = fs.openSync(file, "r");
		try { const b = Buffer.alloc(4096); const n = fs.readSync(fd, b, 0, b.length, 0); return JSON.parse(b.subarray(0, n).toString("utf8").split("\n")[0]).cwd; }
		finally { fs.closeSync(fd); }
	} catch { return undefined; }
}

/** The pi-loop package source a settings file lists, if any (exactly pi-loop, not pi-loop-something). */
function piLoopIn(file: string): string | undefined {
	let pkgs: unknown;
	try { pkgs = JSON.parse(fs.readFileSync(file, "utf8")).packages; } catch { return undefined; }
	if (!Array.isArray(pkgs)) return undefined;
	for (const p of pkgs) {
		const src = typeof p === "string" ? p : (p as any)?.source;
		if (typeof src === "string" && /(^|[/:])pi-loop(\.git)?(@[^/@]+)?$/.test(src.replace(/\/+$/, ""))) return src;
	}
	return undefined;
}

/** The version of an installed package source, from its package.json (git: under the agent dir; a local path as is). */
function installedVersion(src: string): string | undefined {
	let dir: string | undefined;
	if (src.startsWith("git:")) dir = path.join(agentDir(), "git", src.slice(4).replace(/@[^/@]+$/, "").replace(/\.git$/, ""));
	else if (src.startsWith("npm:")) dir = path.join(agentDir(), "npm", "node_modules", src.slice(4).replace(/@[^/@]+$/, ""));
	else if (!/^[a-z]+:/.test(src)) dir = path.resolve(agentDir(), src.replace(/^~(?=\/)/, os.homedir()));
	try { return JSON.parse(fs.readFileSync(path.join(dir!, "package.json"), "utf8")).version; } catch { return undefined; }
}

function newerOrSame(v: string, than: string): boolean {
	const a = v.split(".").map(Number), b = than.split(".").map(Number);
	for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
	return true;
}

/** This file, for a run that has to be given pi-loop on its command line. */
function selfPath(): string | undefined {
	try { return fileURLToPath(import.meta.url); } catch { return typeof __filename === "string" ? __filename : undefined; }
}
declare const __filename: string | undefined;

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

/**
 * loop.folders in the project's .pi/settings.json: folders beside the project (e.g. "../business") whose loops
 * this session runs too, as if they were inside it: their .pi/loop.json and their direct subfolders'. Only a true
 * sibling with a .pi folder of its own counts. `unsure` says why the setting couldn't be read in full (its loops
 * are then kept as they were rather than dropped).
 */
export function adoption(cwd: string): { folders: string[]; unsure: string[] } {
	let raw: unknown;
	try { raw = (JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8")) as { loop?: { folders?: unknown } }).loop?.folders; }
	catch (e) { return { folders: [], unsure: (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : [".pi/settings.json could not be read"] }; }
	if (raw === undefined) return { folders: [], unsure: [] };
	if (!Array.isArray(raw)) return { folders: [], unsure: ["loop.folders must be a list of folders like \"../business\""] };
	const root = fs.realpathSync(cwd);
	const folders: string[] = [], unsure: string[] = [];
	for (const f of raw) {
		let abs: string | undefined;
		try { if (typeof f === "string" && f.trim() && !path.isAbsolute(f)) abs = fs.realpathSync(path.resolve(root, f)); } catch { /* missing */ }
		const ok = abs && abs !== root && path.dirname(abs) === path.dirname(root) && !path.basename(abs).startsWith(".")
			&& fs.existsSync(path.join(abs, ".pi")) && fs.statSync(abs).isDirectory();
		if (ok) { if (!folders.includes(abs!)) folders.push(abs!); }
		else unsure.push(`loop.folders: ${JSON.stringify(f)} is not a folder beside this project with a .pi folder of its own`);
	}
	return { folders, unsure };
}
export function configuredFolders(cwd: string): string[] { return adoption(cwd).folders; }

/** loop.maxBackground in the project's or agent's settings.json: background runs at once (absent or 0 = no limit). */
export function configuredMaxBackground(cwd: string): number {
	for (const file of [path.join(cwd, ".pi", "settings.json"), path.join(agentDir(), "settings.json")]) {
		let raw: unknown;
		try { raw = (JSON.parse(fs.readFileSync(file, "utf8")) as { loop?: { maxBackground?: unknown } }).loop?.maxBackground; } catch { continue; }
		if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
	}
	return 0;
}

/** "2d", "12h", "30m" from now, or an ISO time: when an ad hoc loop ends. */
export function parseLifetime(p: { for?: string; until?: string }, now: number): number | string | undefined {
	if (p.for && p.until) return "use either for or until";
	if (p.for) { const ms = parseInterval(p.for.trim()); if (ms === undefined || ms < MIN_INTERVAL_MS) return "for must look like 30m, 12h or 2d"; return now + ms; }
	if (p.until) { const t = Date.parse(p.until); if (!Number.isFinite(t)) return "until must be a time like 2026-10-12T09:00-05:00"; if (t <= now) return "until is in the past"; return t; }
	return undefined;
}

/** loop_report: how a loop's run says what it found and when to run again. Writes to `file()`; in a background run that is PI_LOOP_REPORT. */
function registerReportTool(pi: ExtensionAPI, file: () => string | undefined, run?: string) {
	pi.registerTool({
		name: "loop_report",
		label: "Loop report",
		description: (run
			? `This whole conversation is loop ${run}'s background run, including the owner's later words to it: at the end of each turn of it, say whether it found something the owner should see, `
			: "Only in a loop's turn (its message starts with [loop <id> ...]): say whether this run found something the owner should see, ") +
			"in one line, and optionally when the loop should run next or that it should stop. Call it once, at the end of the run.",
		promptSnippet: "End a loop's run: findings or not, a one-line summary, optional next time or stop",
		parameters: Type.Object({
			findings: Type.Boolean({ description: "true only if there is something the owner should see; false when everything is as expected (the run then stays quiet)." }),
			summary: Type.String({ description: "One line: what this run found or did." }),
			next: Type.Optional(Type.String({ description: "When this loop should run again, e.g. 2m while something is changing, 1h when quiet (1m to 7d)." })),
			stop: Type.Optional(Type.Boolean({ description: "true when what this loop watches is done, so it should end." })),
		}),
		async execute(_id, p) {
			const f = file();
			if (!f) return { content: [{ type: "text", text: "No loop run is in progress here, so there is nothing to report to." }], details: {} };
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(f, JSON.stringify({ findings: !!p.findings, summary: p.summary, ...(p.next ? { next: p.next } : {}), ...(p.stop ? { stop: true } : {}) }));
			return { content: [{ type: "text", text: "Reported." }], details: {} };
		},
	});
}

function readReport(file: string): Report | undefined {
	try { const r = JSON.parse(fs.readFileSync(file, "utf8")); return { findings: !!r.findings, summary: r.summary, next: r.next, stop: !!r.stop }; } catch { return undefined; }
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
	if (tokens[0]?.toLowerCase() === "auto") {
		schedule = { kind: "auto" };
		rest = tokens.slice(1);
	} else if (every !== undefined) {
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
	if (!prompt) return { error: "usage: /loop [10m|2h|1d|auto|at HH:MM [Area/City]] [--fork|--thread|--fresh] [--for 2d|--until <time>] <prompt>" };
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

/** Inside the project, or one of the folders it adopts (loop.folders): those folders count as part of it. */
function within(cwd: string, abs: string): boolean {
	const root = fs.realpathSync(cwd);
	return abs.startsWith(root + path.sep) || configuredFolders(cwd).some(f => abs === f || abs.startsWith(f + path.sep));
}

/** A folder inside the project (or a folder it adopts), normalized relative to it; undefined for the project itself. Throws if outside. */
function insideDir(cwd: string, dir: string | undefined): string | undefined {
	if (!dir || dir === "." || dir === "./") return undefined;
	if (path.isAbsolute(dir)) throw new Error("dir must be a folder relative to the project");
	const root = fs.realpathSync(cwd);
	let abs: string;
	try { abs = fs.realpathSync(path.resolve(root, dir)); } catch { throw new Error(`dir ${dir} does not exist`); }
	if (abs === root) return undefined;
	if (!within(cwd, abs)) throw new Error("dir must be inside the project (or a folder its loop.folders setting adopts)");
	if (!fs.statSync(abs).isDirectory()) throw new Error(`dir ${dir} is not a folder`);
	return path.relative(root, abs);
}

export default function loopExtension(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	// A loop's background run: no loops of its own here (they belong to the session that started it), only loop_report.
	if (process.env.PI_LOOP_CHILD === "1") {
		registerReportTool(pi, () => process.env.PI_LOOP_REPORT || undefined, process.env.PI_LOOP_ID || "this");
		pi.on("session_start", (_e, c) => { ctx = c; });
		pi.registerCommand("loop", {
			description: "This is a loop's background run; its loops belong to the session that started it",
			handler: async () => { try { ctx?.ui.notify("This is a loop's background run. Its loops belong to the session that started it; /loop leave there brings you back.", "info"); } catch { /* no UI */ } },
		});
		return;
	}
	let timer: ReturnType<typeof setInterval> | undefined;
	let file = "";
	let lock = "";
	let readOnly = false;
	let loops: Loop[] = [];
	let zone: ReturnType<typeof configuredZone> = { tz: systemZone(), source: "system" };
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
	/** Declaring files (.pi/loop.json, relative to the project) whose folder another session holds: their loops wait. */
	let foreign = new Set<string>();
	let ticks = 0;
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
	const busy = () => { if (shared.away || shared.leaving) return true; try { return !ctx!.isIdle() || !!ctx!.hasPendingMessages?.() || !!phase; } catch { return true; } };
	let maxBackground = 0;
	const overLimit = () => maxBackground > 0 && shared.runs.size >= maxBackground;
	/** Background loops waiting for a slot (to say so, rather than "waiting for this session"). */
	const slotWait = new Set<string>();
	const reportFileOf = (l: Loop, fire: number) => path.join(stateDirOf(l), `report-${fire}.json`);

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
	/** The claim in flight, if any: settles after it has been applied. */
	let claiming: Promise<unknown> | undefined;
	function claimLock(then: () => void) {
		const l = folderLock;
		if (!l) return;
		const c: Promise<unknown> = claiming = l.claim().then(ok => {
			if (claiming === c) claiming = undefined;
			if (!ok || l !== folderLock || !ctx) {
				if (!lockAvailable() && !lockWarned) { lockWarned = true; notify("pi-loop needs perl (in the base system on macOS and most Linux) for its lock; without it this session can't run loops", "warning"); }
				return;
			}
			readOnly = false;
			then();
		});
	}
	/** A session that has just started is still taking its lock: wait a little for it rather than say it isn't the owner. */
	async function settledClaim() {
		const c = claiming;
		if (readOnly && c) await Promise.race([c, new Promise(r => setTimeout(r, 5_000).unref?.())]);
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
		if (!loops.length) { ctx.ui.setStatus(STATUS_KEY, undefined); return; }
		if (readOnly) { ctx.ui.setStatus(STATUS_KEY, `loops: ${loops.length} (owned by pid ${ownerPid()})`); return; }
		if (shared.away) { ctx.ui.setStatus(STATUS_KEY, `loops: in ${shared.away.id}'s run · /loop leave or /loop done`); return; }
		const now = Date.now();
		const bg = shared.runs.size ? ` · ${shared.runs.size} in background` : "";
		const unread = loops.filter(l => l.lastRun?.unread).length;
		const inbox = unread ? ` · ${unread} to see (/loop)` : "";
		const waiting = (waited.size ? ` \u00b7 ${waited.size} waiting` : "") + bg + inbox;
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
		const head = (readOnly ? `(read-only: loops owned by pid ${ownerPid()})\n` : "") + (shared.away ? `(you are in ${shared.away.id}'s run: /loop leave lets it carry on, /loop done finishes it)\n` : "");
		return head + loops.map(l => {
			const live = shared.runs.get(l.id);
			const state = live ? `running in background (${live.mode}, ${live.working ? "working" : "idle"})` : shared.away?.id === l.id ? "you are in its run" : l.paused ? "paused" : `next ${when(l)}`;
			const p = l.prompt.length > 70 ? `${l.prompt.slice(0, 67)}…` : l.prompt;
			const extra = [l.run ? `runs in background: ${l.run}` : "", l.dir ? `folder ${l.dir}/` : "", l.priority ? `priority ${l.priority}` : "", l.source ? `declared in ${l.source}` : "",
				l.expiresAt ? `ends ${fmtTime(l.expiresAt, zoneOf(l))}` : "", slotWait.has(l.id) ? `waiting for a background slot (loop.maxBackground ${maxBackground})` : waited.has(l.id) ? "waiting for this session to be free" : ""].filter(Boolean);
			const r = l.lastRun;
			const last = r && !live ? `\n    last run #${r.fire} ${r.status}${r.endedAt ? ` ${countdown(Math.max(0, Date.now() - r.endedAt))} ago` : ""}${r.unread ? " (new)" : ""}${r.result ? `: ${r.result.split("\n")[0].slice(0, 120)}` : ""}${r.needsYou ? ` · needs you: ${r.needsYou}` : ""}` : "";
			return `${l.id}  ${desc(l)}  ${state}  ×${l.fires}\n    ${p}${extra.length ? `\n    ${extra.join(" · ")}` : ""}${l.gate ? `\n    ${gateText(l)}` : ""}${last}`;
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

	function add(schedule: Schedule, prompt: string, id?: string, tz?: string, gate?: GateConfig, more: Pick<Loop, "priority" | "dir" | "context" | "run" | "expiresAt"> = {}): Loop | string {
		if (readOnly) return `loops are owned by pid ${ownerPid()}; manage them from that session`;
		if (tz && !zoned(schedule)) return "a time zone applies only to `at` loops and whole-day intervals (1d, 7d)";
		const base = id?.trim() || slug(prompt);
		let unique = base;
		for (let n = 2; loops.some(l => l.id === unique); n++) unique = `${base}-${n}`;
		const now = Date.now();
		const loop: Loop = {
			id: unique, prompt, schedule, paused: false, createdAt: now, fires: 0,
			catchUp: catchUpOf(schedule),
			nextAt: 0,
			// Ad hoc loops end: after 7 days unless they say when.
			expiresAt: more.expiresAt ?? now + AD_HOC_LIFETIME_MS,
			...(more.run ? { run: more.run } : {}),
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
				// A background loop needs only its own run slot, not the session.
				const blocked = l.run ? shared.runs.has(l.id) || overLimit() : busy() || activity !== act;
				if (raw.action === "wake" && !l.paused && (closing || blocked)) {
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
		if (l.source && foreign.has(l.source)) return `${l.id}'s folder is held by another session (its .pi/loops.lock); it runs there`;
		try { home(l); } catch (e) { const msg = `loop ${l.id}: ${(e as Error).message}; not fired`; notify(msg, "warning"); return msg; }
		if (l.run) return fireBackground(l, reason, gate);
		// You are in a run's conversation: an in-conversation loop waits for you to be back.
		if (shared.away) {
			if (gate) l.pendingWake = { reason: gate.reason, ...(gate.context ? { context: gate.context } : {}), at: Date.now(), rev: l.rev ?? 0 };
			waited.set(l.id, waited.get(l.id) ?? Date.now());
			save(); refreshStatus();
			return `you are in ${shared.away.id}'s run; ${l.id} runs when you are back`;
		}
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
		const { text, expand } = compose(l.prompt, header + where, evidence + `\n\n${REPORT_HINT}`, home(l), commands, !!l.dir);
		inConversation = { id: l.id, report: reportFileOf(l, l.fires) };
		try { fs.rmSync(inConversation.report, { force: true }); } catch { /* none */ }
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

	/** The loop whose turn is running in this conversation now, and where its loop_report goes. */
	let inConversation: { id: string; report: string } | undefined;

	/** The prompt a loop's run gets: its header, folder, gate context and the report hint. */
	function runText(l: Loop, fireNo: number, reason: Reason, gate?: GateDecision, mode?: RunMode): { text: string; expand: boolean } {
		const why = gate ? ` · gate: ${gate.reason.replace(/\s*[\r\n]+\s*/g, " ").trim()}` : "";
		const header = `[loop ${l.id} · ${desc(l)} · fire #${fireNo}${mode ? ` · background ${mode}` : ""}${reason === "due" ? "" : ` · ${reason}`}${why}]`;
		const evidence = (gate?.context ? `\n\n<gate-context>\n${gate.context}\n</gate-context>` : "") + `\n\n${REPORT_HINT}`;
		let commands: CommandInfo[] = [];
		try { commands = (pi as any).getCommands?.() ?? []; } catch { /* older Pi */ }
		return compose(l.prompt, header + loopContext(l), evidence, home(l), commands, !!l.dir);
	}

	/** The session arguments for a background run of `mode`, and the mode it really gets. */
	function sessionArgsFor(l: Loop, mode: RunMode): { args: string[]; mode: RunMode; note?: string } {
		// While you are in a run, "this conversation" is still the one you left.
		const here = shared.away ?? shared.leaving;
		const main = here?.home ?? ctx!.sessionManager.getSessionFile?.();
		// Beside this session's folder: Pi's own per-project folder (--<cwd>--), or the --session-dir it was given.
		const own = main ? path.dirname(main) : undefined;
		const root = !own ? path.join(agentDir(), "sessions") : /^--.*--$/.test(path.basename(own)) ? path.dirname(own) : own;
		// Named after the loop's own folder (the project, or its dir): --<folder>-loop-<id>--, so tools that read
		// session folders can tell whose job a run was.
		const dir = sessionFolder(root, fs.realpathSync(home(l)), `-loop-${l.id}`);
		moveLegacyFolder(l, sessionFolder(root, fs.realpathSync(ctx!.cwd), `-loop-${l.id}`), dir);
		if (mode === "fork" && !main) return { args: ["--session-dir", dir], mode: "fresh", note: "this session isn't saved, so it ran fresh" };
		if (mode === "fork") return { args: ["--fork", main!, "--session-dir", dir], mode };
		if (mode === "thread") {
			// Pi continues only a conversation made in the run's folder; one made elsewhere (before 0.5, runs worked in
			// the project) carries on as a copy made here.
			const where = fs.realpathSync(home(l));
			let files: string[] = [];
			try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(f => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); } catch { /* none yet */ }
			if (files.length && !files.some(f => headerCwd(f) === where)) return { args: ["--fork", files[0], "--session-dir", dir], mode, note: "its thread carries on from a copy made in its folder" };
			return { args: ["--session-dir", dir, "--continue"], mode };
		}
		return { args: ["--session-dir", dir], mode };
	}

	/**
	 * 0.4.0 named every loop's folder after the session's cwd. A loop with its own folder (dir) now has its own
	 * name; its old folder is moved there once, so a thread carries on and its last run can still be opened.
	 */
	function moveLegacyFolder(l: Loop, legacy: string, dir: string) {
		if (legacy === dir || !fs.existsSync(legacy) || fs.existsSync(dir)) return;
		try { fs.renameSync(legacy, dir); } catch { return; }
		const s = l.lastRun?.session;
		if (s && s.startsWith(legacy + path.sep)) { l.lastRun!.session = dir + s.slice(legacy.length); save(); }
	}

	/**
	 * How a run in `folder` gets pi-loop (for loop_report), exactly once and never an older copy that would run
	 * that folder's loops itself: the folder's own pinned pi-loop, else this machine's own (personal) one if it is
	 * 0.5 or later, else this file with -e. Throws when the machine's own pi-loop is older.
	 */
	function runExtra(folder: string): string[] {
		if (folder === fs.realpathSync(ctx!.cwd)) return []; // this project: it loads pi-loop as this session does
		const me = selfPath();
		const dir = me ? path.dirname(me) : undefined;
		const inherited = extensionFlags(process.argv.slice(2));
		for (let i = 0; i < inherited.length; i++) {
			const v = inherited[i + 1];
			if ((inherited[i] === "-e" || inherited[i] === "--extension") && v && dir && (v === me || v === dir || v.startsWith(dir + path.sep))) return [];
		}
		if (piLoopIn(path.join(folder, ".pi", "settings.json"))) return [];
		const own = piLoopIn(path.join(agentDir(), "settings.json"));
		if (own) {
			const v = installedVersion(own);
			if (v && newerOrSame(v, "0.5.0")) return [];
			throw new Error(`this machine's own pi-loop (${v ?? "unknown version"}, ~/.pi/agent/settings.json) is older than 0.5: in ${folder} it would run that folder's loops itself. Update it to 0.5 or later`);
		}
		return me ? ["-e", me] : [];
	}

	/** Where a run of `l` works and what it is given there: its folder, pi-loop for loop_report, its model. */
	function runPlace(l: Loop): { cwd: string; extra: string[]; model?: string; thinking?: string } {
		const where = home(l);
		return { cwd: where, extra: runExtra(where), ...modelArgs(l) };
	}

	function childEnv(l: Loop, report: string): NodeJS.ProcessEnv {
		const sm = ctx!.sessionManager;
		// The parent's session id (as subagents pass it), so tools that group sessions can file the run under it.
		const here = shared.away ?? shared.leaving;
		const id = here ? here.homeId ?? "" : sm.getSessionId?.() ?? "";
		const file = here?.home ?? sm.getSessionFile?.() ?? "";
		return { ...process.env, PI_LOOP_CHILD: "1", PI_LOOP_ID: l.id, PI_LOOP_REPORT: report, PI_LOOP_PARENT_SESSION: id, PI_LOOP_PARENT_FILE: file };
	}

	function modelArgs(l?: Loop): { model?: string; thinking?: string } {
		if (l?.model) {
			const i = l.model.lastIndexOf(":");
			const lvl = i > 0 ? l.model.slice(i + 1) : "";
			return /^(off|minimal|low|medium|high|xhigh|max)$/.test(lvl) ? { model: l.model.slice(0, i), thinking: lvl } : { model: l.model };
		}
		const m = ctx?.model;
		let thinking: string | undefined;
		try { thinking = (pi as any).getThinkingLevel?.(); } catch { /* older Pi */ }
		return m ? { model: `${m.provider}/${m.id}`, thinking } : {};
	}

	/**
	 * A background loop's turn: a child Pi on a fork of this session, the loop's own thread, or a fresh one.
	 * The loop is rescheduled at once; the occurrence counts as fired once the child has accepted its prompt.
	 */
	function fireBackground(l: Loop, reason: Reason, gate?: GateDecision): string | undefined {
		if (shared.runs.has(l.id)) { shared.again.add(l.id); return; }
		if ((shared.away ?? shared.leaving)?.id === l.id) { shared.again.add(l.id); return; }
		const now = Date.now();
		if (overLimit()) {
			// Its turn waits for a slot (loop.maxBackground); a gate's wake is kept.
			if (gate) l.pendingWake = { reason: gate.reason, ...(gate.context ? { context: gate.context } : {}), at: now, rev: l.rev ?? 0 };
			slotWait.add(l.id); waited.set(l.id, waited.get(l.id) ?? now);
			l.nextAt = Math.min(l.nextAt, now);
			save(); refreshStatus();
			return `loop ${l.id} waits for a background slot (loop.maxBackground ${maxBackground})`;
		}
		slotWait.delete(l.id);
		const fireNo = l.fires + 1;
		// In the loop's own folder, so Pi gives the run that folder's settings, tools (.pi/mcp.json), prompts, data class
		// and AGENTS.md; pi-loop itself comes along for loop_report when that folder isn't this project.
		let place: ReturnType<typeof runPlace>;
		try { place = runPlace(l); } catch (e) {
			const msg = (e as Error).message;
			l.nextAt = nextFor(l, now);
			l.lastRun = { fire: fireNo, mode: l.run!, status: "failed", startedAt: now, endedAt: now, host: process.pid, result: msg.slice(0, 2000), findings: true, unread: true };
			save(); refreshStatus();
			deliver({ content: `[loop ${l.id} · background ${l.run} · couldn't start] ${msg}`, details: { id: l.id, status: "failed" } });
			return `${l.id}: ${msg}`;
		}
		const s = sessionArgsFor(l, l.run!);
		const report = reportFileOf(l, fireNo);
		try { fs.rmSync(report, { force: true }); } catch { /* none */ }
		const composed = runText(l, fireNo, reason, gate, s.mode);
		// A command (not a prompt template here) runs only as its own message: Pi doesn't read "/cmd" followed by the
		// header on new lines as that command. It then has no header or report hint; what it does is its own.
		// A skill (/skill:name) reads its name up to the first space, so the header can follow on the same line.
		const head = `[loop ${l.id} · ${desc(l)} · fire #${fireNo} · background ${s.mode}${reason === "due" ? "" : ` · ${reason}`}${gate ? ` · gate: ${gate.reason.replace(/\s*[\r\n]+\s*/g, " ").trim()}` : ""}]`;
		const evidence = (gate?.context ? `\n\n<gate-context>\n${gate.context}\n</gate-context>` : "") + `\n\n${REPORT_HINT}`;
		const text = !(composed.expand && l.prompt.startsWith("/")) ? composed.text
			: l.prompt.startsWith("/skill:") ? `${l.prompt} ${head}${evidence}` : l.prompt;
		const run = new Run(l.id, fireNo, s.mode, { ...place, sessionArgs: s.args, env: childEnv(l, report) });
		shared.runs.set(l.id, run);
		if (reason !== "manual" || l.nextAt <= now) l.nextAt = nextFor(l, now);
		waited.delete(l.id);
		l.lastRun = { fire: fireNo, mode: s.mode, status: "starting", startedAt: now, host: process.pid };
		save(); refreshStatus();
		void (async () => {
			try {
				await run.start();
				if (run.handedOver) return; // taken over while starting: the run is yours now
				await run.prompt(text);
			} catch (e) {
				if (run.handedOver) return;
				await run.stop();
				if (shared.runs.get(l.id) === run) shared.runs.delete(l.id);
				// Recorded by whichever instance is live now (a session switch may have replaced this one).
				live(cur => cur.runFailed(l.id, run, (e as Error).message, now, gate));
				return;
			}
			if (run.handedOver) return;
			live(cur => cur.runStarted(l.id, run, s.note));
			await watchRun(run, report);
		})();
		return undefined;
	}

	function runStarted(id: string, run: Run, note?: string) {
		const cur = loops.find(x => x.id === id);
		if (!cur || run.handedOver) return;
		delete cur.startFailures;
		cur.fires = Math.max(cur.fires, run.fire);
		cur.lastFiredAt = cur.lastWokeAt = Date.now();
		delete cur.pendingWake;
		cur.lastRun = { ...(cur.lastRun ?? { fire: run.fire, mode: run.mode, startedAt: Date.now() }), status: "running", session: run.sessionFile, host: process.pid };
		save(); refreshStatus();
		if (note) notify(`loop ${id}: ${note}`, "info");
	}

	function runFailed(id: string, run: Run, why: string, startedAt: number, gate?: GateDecision) {
		const cur = loops.find(x => x.id === id);
		if (!cur) return;
		// A gate may have recorded that it reported this: keep its wake rather than ask it again. Otherwise try
		// this occurrence again soon, a few times, before leaving it to the schedule.
		cur.startFailures = (cur.startFailures ?? 0) + 1;
		const retry = cur.startFailures <= 3;
		if (gate) cur.pendingWake = { reason: gate.reason, ...(gate.context ? { context: gate.context } : {}), at: Date.now(), rev: cur.rev ?? 0 };
		else if (retry) cur.nextAt = Math.min(cur.nextAt, Date.now() + 2 * 60_000);
		// A run started again on its own conversation (leave, steer) keeps that conversation: it can still be opened.
		const session = run.sessionFile ?? (cur.lastRun?.fire === run.fire ? cur.lastRun?.session : undefined);
		cur.lastRun = { fire: run.fire, mode: run.mode, status: "failed", startedAt, endedAt: Date.now(), result: `couldn't start: ${why}`, findings: true, unread: true, host: process.pid, ...(session ? { session } : {}) };
		save(); refreshStatus();
		notify(`loop ${id}: its background run couldn't start (${why}); ${gate || retry ? "it is tried again soon" : "it runs again at its next time"}`, "warning");
	}

	/** Wait until a run has really finished (idle and staying idle), then hand it to the live instance. */
	async function watchRun(run: Run, report: string) {
		for (;;) {
			await run.waitIdle(24 * 60 * 60_000);
			if (run.handedOver) return;
			if (run.exited) break;
			await new Promise(r => setTimeout(r, 1500));
			if (!run.working || run.exited) break;
		}
		if (run.handedOver) return;
		live(cur => cur.finishRun(run.loopId, run, report));
	}

	/** A run is over: collect what it came to, then have the live instance record it (a switch may happen meanwhile). */
	async function finishRun(id: string, run: Run, report: string) {
		if (run.handedOver || run.recorded || run.finishing) return;
		run.finishing = true;
		const text = run.exited ? (run.sessionFile ? lastAssistantText(run.sessionFile) : undefined) : await run.lastText();
		if (run.handedOver) return; // taken over while its answer was being read
		const crashed = run.exited && !run.cancelled;
		await run.stop();
		if (run.handedOver) return;
		const rep = readReport(report);
		const status = run.cancelled ? "cancelled" : crashed ? "failed" : "done";
		const findings = status === "failed" || !!run.needsYou || (rep ? rep.findings : true);
		const summary = (crashed ? "its Pi exited before the run finished" : rep?.summary) ?? text?.split("\n").find(x => x.trim())?.trim() ?? "(no answer)";
		live(cur => cur.recordRun(id, run, { status, summary, findings, rep }));
	}

	/** Record a finished run once: its record, what it reported, again, and a note only if it found something. */
	function recordRun(id: string, run: Run, o: Outcome) {
		if (run.recorded || run.handedOver) return;
		run.recorded = true;
		if (shared.runs.get(id) === run) shared.runs.delete(id);
		const l = loops.find(x => x.id === id);
		const rec: RunRecord = { fire: run.fire, mode: run.mode, status: o.status, startedAt: l?.lastRun?.startedAt ?? Date.now(), endedAt: Date.now(), session: run.sessionFile, host: process.pid,
			result: o.summary.slice(0, 2000), findings: o.findings, ...(run.needsYou ? { needsYou: run.needsYou } : {}), unread: o.findings && o.status !== "cancelled" };
		if (l) {
			l.lastRun = rec;
			if (o.status === "done" && o.rep) applyReport(l, o.rep);
			// Due again while it ran: once more now, unless the run chose its own next time (or the loop paces itself).
			const again = shared.again.delete(id) && !o.rep?.next && l.schedule.kind !== "auto";
			if (again && loops.includes(l) && !l.paused) l.nextAt = Math.min(l.nextAt, Date.now());
			save(); refreshStatus();
		}
		if (rec.unread) deliver({ content: `[loop ${id} · background ${run.mode} · run #${run.fire} · ${o.status}] ${rec.result}${rec.needsYou ? `\nneeds you: ${rec.needsYou}` : ""}${rec.session ? `\n(/loop open ${id} to go into it)` : ""}`,
			details: { id, fire: run.fire, mode: run.mode, status: o.status, session: rec.session } });
	}

	/** A loop_report's next / stop. */
	function applyReport(l: Loop, rep: Report) {
		if (rep.stop) {
			if (l.source) { l.paused = true; notify(`loop ${l.id} asked to stop; it is declared in ${l.source}, so it is paused`, "info"); }
			else { loops = loops.filter(x => x !== l); notify(`loop ${l.id} finished what it was watching and ended`, "info"); }
			return;
		}
		if (rep.next) {
			const ms = parseInterval(rep.next.trim());
			if (ms !== undefined) l.nextAt = Date.now() + Math.min(Math.max(ms, MIN_INTERVAL_MS), MAX_NEXT_MS);
		}
	}

	/** Findings into the main conversation, quietly (no turn); kept until you are back if you are in a run. */
	function deliver(n: Note) {
		if (shared.away || shared.leaving) { shared.notes.push(n); return; }
		try {
			pi.sendMessage({ customType: "loop-result", content: n.content, display: true, details: n.details }, busy() ? { deliverAs: "nextTurn" } : undefined);
		} catch { shared.notes.push(n); }
	}

	function flushNotes() { for (const n of shared.notes.splice(0)) deliver(n); }

	/** Go into a loop's run as a regular session: the background Pi stops at a safe point first (or now). */
	async function takeOver(id: string, now: boolean, cctx: any): Promise<string | undefined> {
		if (readOnly) return `loops are owned by pid ${ownerPid()}`;
		if (shared.away) return `you are already in ${shared.away.id}'s run; /loop leave or /loop done first`;
		const l = find(id);
		if (!l) return `no loop "${id}"`;
		const run = shared.runs.get(l.id);
		const file = run?.sessionFile ?? l.lastRun?.session;
		if (!file) return `${l.id} has no run to go into`;
		// Pi opens a conversation in the folder it was started in: going into a run from another folder would move this
		// session there (another project's lock, settings and data class). Watch and steer it from here instead.
		const there = headerCwd(file);
		if (there && there !== fs.realpathSync(ctx!.cwd)) {
			return `${l.id}'s run works in ${there}, not this folder, so you can't step into it from here: watch it (/loop watch ${l.id}) and steer it (/loop steer ${l.id} <words>), or once it has finished open it there: cd ${there} && pi --session ${file}`;
		}
		const homeFile = ctx!.sessionManager.getSessionFile?.();
		if (!homeFile) return "this session isn't saved, so pi-loop couldn't bring you back to it";
		// Pi writes a conversation to disk after its first exchange; before that there is nothing to come back to.
		if (!fs.existsSync(homeFile)) return "this conversation has nothing saved yet (Pi saves it after its first exchange), so pi-loop couldn't bring you back to it; say something here first";
		if (run?.working) notify(`waiting for ${l.id}'s run to stop at its next step${now ? "" : " (up to a minute)"}…`, "info");
		await cctx.waitForIdle?.();
		const fireNo = run?.fire ?? l.lastRun?.fire ?? l.fires;
		if (run) {
			run.handedOver = true;
			if (run.working) {
				if (now) await run.abort();
				else { await run.steer(TAKEOVER_NOTE); if (!(await run.waitIdle(60_000))) await run.abort(); }
			}
			await run.stop();
			shared.runs.delete(l.id);
		}
		const prev = l.lastRun;
		l.lastRun = { ...(l.lastRun ?? { fire: fireNo, mode: l.run ?? "fresh", startedAt: Date.now() }), status: "away", session: file, unread: false, host: process.pid };
		const away: Away = { id: l.id, file, home: homeFile, homeId: ctx!.sessionManager.getSessionId?.(), fire: fireNo, mode: l.lastRun.mode, report: reportFileOf(l, fireNo), live: !!run };
		shared.away = away;
		save(); refreshStatus();
		let res: any;
		try {
			res = await cctx.switchSession(file, { withSession: async (c: any) => {
				try { c.ui.notify(`You are in ${l.id}'s run #${fireNo}. /loop leave lets it carry on in the background; /loop done finishes it; both bring you back.`, "info"); } catch { /* no UI */ }
			} });
		} catch { res = { cancelled: true }; }
		if (res?.cancelled) {
			// The switch didn't happen: you are still here. A live run carries on in the background; a finished one
			// you only meant to read stays as it was (nothing starts in it).
			shared.away = undefined;
			if (away.live) { live(cur => cur.afterLeave(away, false)); return "couldn't switch into the run; it carries on in the background"; }
			l.lastRun = prev; save(); refreshStatus();
			return "couldn't switch into the run";
		}
		return undefined;
	}

	/** Back to the main session: the run carries on in the background (leave) or is finished (done). */
	async function leave(finish: boolean, cctx: any): Promise<string | undefined> {
		const a = shared.away;
		if (!a) return "you are not in a loop's run";
		await cctx.waitForIdle?.();
		// Cleared before the switch, so the session that starts there doesn't read it as leaving some other way;
		// `leaving` holds notes and turns until you are there.
		shared.away = undefined;
		shared.leaving = a;
		let res: any;
		try {
			res = await cctx.switchSession(a.home, { withSession: async (c: any) => {
				try { c.ui.notify(finish ? `Back. ${a.id}'s run is finished.` : `Back. ${a.id}'s run carries on in the background.`, "info"); } catch { /* no UI */ }
			} });
		} catch (e) { res = { cancelled: true, error: (e as Error).message }; }
		if (res?.cancelled) { shared.leaving = undefined; shared.away = a; return `couldn't switch back${res.error ? `: ${res.error}` : ""}; you are still in ${a.id}'s run`; }
		// The instance that runs from here on picks this up (Pi rebuilds extensions on a switch). Not awaited: you
		// are back at once; the run carries on by itself.
		live(cur => { shared.leaving = undefined; return cur.afterLeave(a, finish); });
		return undefined;
	}

	/** In the instance that runs after a switch back: finish the run, or start it again in the background. */
	async function afterLeave(a: Away, finish: boolean) {
		const l = loops.find(x => x.id === a.id);
		if (finish || !l) {
			const text = lastAssistantText(a.file);
			const rep = readReport(a.report);
			const rec: RunRecord = { fire: a.fire, mode: a.mode, status: "done", startedAt: l?.lastRun?.startedAt ?? Date.now(), endedAt: Date.now(), session: a.file, host: process.pid,
				result: (rep?.summary ?? text?.split("\n").find(x => x.trim())?.trim() ?? "(no answer)").slice(0, 2000), findings: false, unread: false };
			if (l) { l.lastRun = rec; if (rep) applyReport(l, rep); save(); }
			flushNotes(); refreshStatus();
			return;
		}
		try { fs.rmSync(a.report, { force: true }); } catch { /* none */ }
		let place: ReturnType<typeof runPlace>;
		try { place = runPlace(l); } catch (e) { notify(`${l.id}: ${(e as Error).message}`, "warning"); return; }
		const run = new Run(l.id, a.fire, a.mode, { ...place, sessionArgs: ["--session", a.file], env: childEnv(l, a.report) });
		shared.runs.set(l.id, run);
		l.lastRun = { ...(l.lastRun ?? { fire: a.fire, mode: a.mode, startedAt: Date.now() }), status: "running", session: a.file, host: process.pid };
		save(); refreshStatus(); flushNotes();
		try { await run.start(); if (!run.handedOver) await run.prompt(CONTINUE_NOTE); }
		catch (e) {
			if (run.handedOver) return;
			await run.stop(); if (shared.runs.get(l.id) === run) shared.runs.delete(l.id);
			live(cur => cur.runFailed(l.id, run, `couldn't carry on in the background: ${(e as Error).message}`, Date.now()));
			return;
		}
		if (run.handedOver) return;
		void watchRun(run, a.report);
	}

	/** Stop a running background run. */
	async function cancelRun(id: string): Promise<string> {
		const l = find(id);
		const run = l && shared.runs.get(l.id);
		if (!run) return `${l?.id ?? id} has no run in the background`;
		run.cancelled = true;
		await run.abort();
		await run.stop();
		// Its watcher records it; if none is left to (a lost event), record it here.
		await new Promise(r => setTimeout(r, 2500));
		if (shared.runs.get(l!.id) === run && !run.recorded) live(cur => cur.finishRun(l!.id, run, reportFileOf(l!, run.fire)));
		return `stopped ${l!.id}'s run #${run.fire}`;
	}

	/** Your words to a running background run: steered in at its next step, or a new turn if it is idle. */
	async function steerRun(id: string, text: string): Promise<string> {
		const l = find(id);
		let run = l && shared.runs.get(l.id);
		// Its result is being collected: wait for that, then start it again with your words.
		if (run?.finishing) {
			const end = Date.now() + 30_000;
			while (shared.runs.get(l!.id) === run && Date.now() < end) await new Promise(r => setTimeout(r, 200));
			run = shared.runs.get(l!.id);
		}
		if (!run && l && loops.includes(l) && l.lastRun?.session && !readOnly && shared.away?.id !== l.id) return resumeRun(l, text);
		if (!run) return `${l?.id ?? id} has no run in the background${l?.lastRun?.session ? `; /loop open ${l.id} goes into its last one` : ""}`;
		const err = await run.steer(text);
		return err ? `couldn't steer ${l!.id}: ${err}` : `sent to ${l!.id}'s run #${run.fire}`;
	}

	/** A finished (or interrupted) run, started again in the background on its own conversation with your words. */
	async function resumeRun(l: Loop, text: string): Promise<string> {
		const r = l.lastRun!;
		const report = reportFileOf(l, r.fire);
		try { fs.rmSync(report, { force: true }); } catch { /* none */ }
		let place: ReturnType<typeof runPlace>;
		try { place = runPlace(l); } catch (e) { return `${l.id}: ${(e as Error).message}`; }
		const run = new Run(l.id, r.fire, r.mode, { ...place, sessionArgs: ["--session", r.session!], env: childEnv(l, report) });
		shared.runs.set(l.id, run);
		l.lastRun = { ...r, status: "running", unread: false, host: process.pid };
		save(); refreshStatus();
		try { await run.start(); if (!run.handedOver) await run.prompt(`[loop ${l.id} · run #${r.fire} · the owner's words]\n${text}\n\n${REPORT_HINT}`); }
		catch (e) {
			if (run.handedOver) return `${l.id}'s run is yours now`;
			await run.stop(); if (shared.runs.get(l.id) === run) shared.runs.delete(l.id);
			live(cur => cur.runFailed(l.id, run, `couldn't carry on: ${(e as Error).message}`, Date.now()));
			return `couldn't start ${l.id}'s run again: ${(e as Error).message}`;
		}
		if (run.handedOver) return `${l.id}'s run is yours now`;
		void watchRun(run, report);
		return `${l.id}'s run #${r.fire} carries on in the background with your words`;
	}

	/** Rows for the loops view. */
	function viewRows(): LoopRow[] {
		return loops.map(l => {
			const live = shared.runs.get(l.id);
			const r = l.lastRun;
			const state = live ? `running in background (${live.mode}${live.working ? "" : ", idle"})` : shared.away?.id === l.id ? "you are in its run" : l.paused ? "paused" : `next ${when(l)}`;
			const detail = [desc(l), l.run ? `background ${l.run}` : "in conversation", l.expiresAt ? `ends ${fmtTime(l.expiresAt, zoneOf(l))}` : "",
				r && !live ? `last #${r.fire} ${r.status}${r.result ? `: ${r.result.split("\n")[0]}` : ""}${r.needsYou ? ` · needs you` : ""}` : ""].filter(Boolean).join(" · ");
			return { id: l.id, state, detail, running: !!live, hasRun: !!r?.session, unread: !!r?.unread, paused: l.paused };
		});
	}

	/** The loops view in the terminal UI; acts on what you picked once it closes. */
	async function openView(cctx: any, watch?: string) {
		const action: ViewAction = await cctx.ui.custom((tui: any, theme: any, _kb: any, done: (a: ViewAction) => void) => new LoopsView(tui, theme, {
			rows: viewRows,
			lines: (id: string) => { const l = find(id); return l ? runLines(l) : []; },
			steer: (id: string, text: string) => steerRun(id, text),
			seen: (id: string) => { const l = find(id); if (l?.lastRun?.unread && !readOnly) { l.lastRun.unread = false; save(); refreshStatus(); } },
			title: path.basename(ctx!.cwd),
		}, done, watch), { overlay: true });
		if (!action) return;
		switch (action.action) {
			case "take": { const err = await takeOver(action.id, false, cctx); if (err) notify(err, "warning"); return; }
			case "run": { const l = find(action.id); if (l) { const err = fire(l, "manual"); notify(err ?? `fired ${l.id}`); } return; }
			case "pause": notify(setPaused(action.id, true)); return;
			case "resume": notify(setPaused(action.id, false)); return;
			case "stop": notify(await cancelRun(action.id)); return;
		}
	}

	/** The run's transcript as text: live from a running one, from its file otherwise. */
	function runLines(l: Loop): string[] {
		const run = shared.runs.get(l.id);
		if (run) return run.lines;
		const file = l.lastRun?.session;
		if (!file) return [];
		// The view redraws every second: read a finished run's file again only when it changed.
		let mtime = 0;
		try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
		if (linesCache?.file !== file || linesCache.mtime !== mtime) linesCache = { file, mtime, lines: transcriptOf(file) };
		return linesCache.lines;
	}
	let linesCache: { file: string; mtime: number; lines: string[] } | undefined;

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
				if (!within(ctx!.cwd, abs)) throw new Error("outside");
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
		const under = (dir: string) => {
			let entries: fs.Dirent[] = [];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* unreadable */ }
			for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") at(path.join(dir, e.name));
		};
		under(cwd);
		const own = out.sort();
		// Folders the project adopts (loop.folders): theirs too, after its own.
		const more: string[] = [];
		for (const f of configuredFolders(cwd)) { const n = out.length; at(f); under(f); more.push(...out.splice(n).sort()); }
		return [...own, ...more];
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
		const root = fs.realpathSync(cwd);
		// loop.folders not fully readable: the adopted folders' loops stay as they were rather than vanish.
		const adopt = adoption(cwd);
		for (const m of adopt.unsure) if (declaredErrors.get(`settings#${m}`) !== m) { declaredErrors.set(`settings#${m}`, m); notify(m, "warning"); }
		if (adopt.unsure.length) for (const l of loops) if (l.source?.startsWith("..")) broken.add(l.source);
		// One session runs a folder's declared loops: this one holds each declaring folder's lock (the lock a session
		// started in that folder would take), so a session opened there is read-only rather than running them twice.
		foreign = new Set();
		const locks = shared.folderLocks ??= new Map();
		for (const file of files) {
			let folder: string;
			try { folder = fs.realpathSync(path.dirname(path.dirname(file))); } catch { continue; }
			if (folder === root) continue;
			let lk = locks.get(folder);
			if (!lk) { lk = new FolderLock(path.join(folder, ".pi", "loops.lock"), {}, () => { declaredSeen = undefined; }); locks.set(folder, lk); }
			if (lk.mine()) continue;
			foreign.add(path.relative(cwd, file));
			const claim = lk;
			void claim.claim().then(ok => { if (ok && ctx && !readOnly && locks.get(folder) === claim) { declaredSeen = undefined; syncDeclared(); } });
		}
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
			// Another session holds its folder (or this one is still taking it): its loops wait as they were.
			if (foreign.has(source)) { broken.add(source); continue; }
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
						catchUp: catchUpOf(def.schedule) };
					loop.nextAt = nextFor(loop, now);
					loops.push(loop); changed = true;
					continue;
				}
				const defOf = (x: Loop) => JSON.stringify([x.prompt, x.schedule, x.tz, x.gate, x.priority, x.dir, x.context, x.run, x.model, x.expiresAt]);
				const before = defOf(l);
				const reschedule = JSON.stringify(l.schedule) !== JSON.stringify(def.schedule) || l.tz !== def.tz;
				Object.assign(l, def);
				for (const k of ["tz", "gate", "priority", "dir", "context", "run", "model", "expiresAt"] as const) if ((def as any)[k] === undefined) delete (l as any)[k];
				l.catchUp = catchUpOf(l.schedule);
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

	function fromDeclared(d: Declared, folder: string): Pick<Loop, "id" | "prompt" | "schedule" | "tz" | "gate" | "priority" | "dir" | "context" | "run" | "model" | "expiresAt"> {
		if (!d || typeof d !== "object") throw new Error("not an object");
		if (typeof d.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(d.id)) throw new Error("id: letters, digits, . _ -");
		if (typeof d.prompt !== "string" || !d.prompt.trim()) throw new Error("prompt is required");
		if (d.every && d.at) throw new Error("use either every or at");
		let schedule: Schedule;
		if (d.at) { const a = parseAt(d.at); if (!a) throw new Error("at must be HH:MM"); schedule = { kind: "at", ...a }; }
		else {
			if (d.every?.trim().toLowerCase() === "auto") schedule = { kind: "auto" };
			else {
				const ms = d.every ? parseInterval(d.every) : DEFAULT_INTERVAL_MS;
				if (ms === undefined) throw new Error("every must look like 5m, 2h or 1d, or be auto");
				if (ms < MIN_INTERVAL_MS) throw new Error("minimum interval is 1m");
				schedule = { kind: "every", ms };
			}
		}
		if (d.run !== undefined && !RUN_MODES.includes(d.run as RunMode)) throw new Error("run must be fork, thread or fresh (or omitted)");
		if (d.model !== undefined && (typeof d.model !== "string" || !/^[^\s/]+\/[^\s]+$/.test(d.model))) throw new Error("model must look like provider/id or provider/id:thinking");
		if (d.model && !d.run) throw new Error("model applies to a background loop (run: fork, thread or fresh); a loop in this conversation uses its model");
		const tz = d.timezone ? validZone(d.timezone) : undefined;
		if (d.timezone && !tz) throw new Error(`unknown time zone "${d.timezone}"`);
		if (tz && !zoned(schedule)) throw new Error("a time zone applies only to at loops and whole-day intervals");
		const realFolder = fs.realpathSync(folder), realRoot = fs.realpathSync(ctx!.cwd);
		if (realFolder !== realRoot && !realFolder.startsWith(realRoot + path.sep) && !d.run)
			throw new Error("a loop in an adopted folder runs in the background (run: fork, thread or fresh), where that folder's tools, model and data class apply");
		const dir = insideDir(ctx!.cwd, path.relative(realRoot, folder) || undefined);
		const gate = d.gate ? gateConfig({ gate: d.gate, maxSleep: d.maxSleep, gateTimeout: d.gateTimeout, gateOnError: d.gateOnError }, dir) : undefined;
		if (d.priority !== undefined && !Number.isFinite(d.priority)) throw new Error("priority must be a number");
		const context = contextFiles(d.context);
		// A declared loop lives until its file stops declaring it, unless it says until when (until, an absolute time).
		if (d.for) throw new Error("for is for loops made in a session; a declared loop can say until (an ISO time)");
		const ends = d.until ? parseLifetime({ until: d.until }, 0) : undefined;
		if (typeof ends === "string") throw new Error(ends);
		return { id: d.id, prompt: d.prompt.trim(), schedule, ...(tz ? { tz } : {}), ...(gate ? { gate } : {}),
			...(d.priority ? { priority: d.priority } : {}), ...(dir ? { dir } : {}), ...(context ? { context } : {}),
			...(d.run ? { run: d.run as RunMode } : {}), ...(d.model ? { model: d.model } : {}), ...(ends ? { expiresAt: ends } : {}) };
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
		expire(now);
		for (const id of waited.keys()) if (!loops.some(l => l.id === id && !l.paused)) waited.delete(id);
		for (const id of slotWait) if (!loops.some(l => l.id === id && !l.paused)) slotWait.delete(id);
		// A kept wake whose loop was redefined since is about the old definition: drop it.
		for (const l of loops) if (l.pendingWake && l.pendingWake.rev !== (l.rev ?? 0)) { delete l.pendingWake; save(); }
		// A held folder is asked again now and then (its owner may have quit).
		if (foreign.size && ++ticks % 4 === 0) { declaredSeen = undefined; syncDeclared(); }
		const dueNow = loops.filter(l => !l.paused && !gating.has(l.id) && !(l.source && foreign.has(l.source)) && (shared.away ?? shared.leaving)?.id !== l.id && (l.nextAt <= now || l.pendingWake));
		// Background loops need only a run slot: each due one starts now, or runs once more after its current run.
		for (const l of dueNow.filter(x => x.run)) {
			if (shared.runs.has(l.id)) {
				// Due again while it runs: once more after it (a self-paced loop's run chooses its own next time instead).
				if (l.schedule.kind !== "auto" && !shared.again.has(l.id)) shared.again.add(l.id);
				if (l.nextAt <= now) { l.nextAt = nextFor(l, now); save(); }
				continue;
			}
			if (overLimit()) { if (!waited.has(l.id)) waited.set(l.id, now); slotWait.add(l.id); continue; }
			consider(l, now);
		}
		// A loop changed from background to in-conversation while a run of it is going waits for that run.
		const fg = dueNow.filter(l => !l.run && !shared.runs.has(l.id));
		if (!fg.length) { refreshStatus(); return; }
		// Busy: due loops wait, once each, for the session to be free; nothing is queued behind the turn.
		if (busy() || [...gating].some(id => !find(id)?.run)) {
			for (const l of fg) if (!waited.has(l.id)) waited.set(l.id, now);
			refreshStatus();
			return;
		}
		// Free: the highest priority goes first, then the longest overdue.
		consider(fg.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.nextAt - b.nextAt)[0], now);
	}

	/** Ad hoc loops past their end are removed (not while a run of theirs is going or you are in one). */
	function expire(now: number) {
		const over = (l: Loop) => l.expiresAt !== undefined && l.expiresAt <= now && !shared.runs.has(l.id) && (shared.away ?? shared.leaving)?.id !== l.id && !gating.has(l.id);
		// A declared loop past its `until` is paused: its file is yours to edit.
		for (const l of loops) if (l.source && over(l) && !l.paused) { l.paused = true; notify(`loop ${l.id} reached its until and is paused (${l.source})`, "info"); save(); }
		const gone = loops.filter(l => !l.source && over(l));
		if (!gone.length) return;
		loops = loops.filter(l => !gone.includes(l));
		for (const l of gone) {
			waited.delete(l.id);
			logDecision(gateLog, { ts: new Date(now).toISOString(), id: l.id, action: "expired", reason: `ended ${fmtTime(l.expiresAt!, zoneOf(l))}`, ms: 0 });
			notify(`loop ${l.id} ended (its time was up)`, "info");
		}
		save(); refreshStatus();
	}

	/** One due loop: skip it if its folder is gone, send a kept wake, realign a missed short loop, or run its gate (or fire). */
	function consider(due: Loop, now: number) {
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
		maxBackground = configuredMaxBackground(c.cwd);
		waited.clear(); declaredSeen = undefined; declaredErrors.clear();
		const self: Instance = { finishRun, recordRun, afterLeave, runStarted, runFailed };
		// Run events go to this instance only once it holds the folder's lock (until then they wait in shared.pending).
		if (shared.current?.finishRun !== finishRun) shared.current = undefined;
		// The same process switching sessions (/new, /resume, going into a loop's run) keeps the folder's lock:
		// releasing it for a moment would let another session here take the loops.
		// You were in a run's conversation and went somewhere else than with /loop leave or /loop done (/new, /resume,
		// the session picker): that is leaving it, and the run carries on in the background.
		const now = c.sessionManager.getSessionFile?.();
		if (shared.away && now !== shared.away.file) {
			const a = shared.away;
			shared.away = undefined;
			// A run that was going carries on; one you only opened to read stays finished.
			shared.pending.push(cur => cur.afterLeave(a, !a.live));
		}
		const kept = shared.lock && shared.lockPath === lock && shared.lock.mine() ? shared.lock : undefined;
		if (kept) {
			folderLock = kept;
			readOnly = false;
			syncDeclared(); reconcile();
			shared.current = self;
			drain();
		} else {
			// A claim the previous instance still had going would otherwise hold the lock for nobody.
			shared.lock?.release();
			folderLock = new FolderLock(lock, {}, () => lostLock());
			shared.lock = folderLock; shared.lockPath = lock;
			readOnly = true;
			claimLock(() => { loops = load(); syncDeclared(); reconcile(); interrupted(); refreshStatus(); shared.current = self; drain(); });
		}
		if (timer) clearInterval(timer);
		timer = setInterval(tick, TICK_MS);
		phase = undefined;
		refreshStatus();
	});

	/** Run events that came while no instance was live. */
	function drain() {
		for (const fn of shared.pending.splice(0)) { try { void fn(shared.current!); } catch { /* one event's problem */ } }
	}

	/** Runs recorded as going under a Pi that is gone (a crash, a restart) were interrupted: say so, never resume them by themselves. */
	function interrupted() {
		let changed = false;
		for (const l of loops) {
			const r = l.lastRun;
			if (!r || !["starting", "running", "away"].includes(r.status) || shared.runs.has(l.id)) continue;
			if (r.host === process.pid && shared.away?.id === l.id) continue;
			l.lastRun = { ...r, status: "interrupted", endedAt: Date.now(), findings: true, unread: true, result: r.result ?? "the Pi running it stopped before it finished" };
			changed = true;
		}
		if (changed) save();
	}

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
		// An in-conversation loop's report: its next time, or that it is done.
		const ic = inConversation;
		inConversation = undefined;
		const l = ic && loops.find(x => x.id === ic.id);
		const r = ic && readReport(ic.report);
		if (l && r && !readOnly) { applyReport(l, r); save(); }
		refreshStatus();
	});

	pi.on("session_shutdown", async (event: { reason?: string }) => {
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
		if (shared.current?.finishRun === finishRun) shared.current = undefined;
		// Only quitting Pi gives up the folder and its background runs; a session switch keeps both.
		if (!event?.reason || event.reason === "quit") {
			const stopping = [...shared.runs].map(([id, run]) => {
				run.handedOver = true;
				const l = loops.find(x => x.id === id);
				if (l?.lastRun && !readOnly) l.lastRun = { ...l.lastRun, status: "interrupted", endedAt: Date.now(), findings: true, unread: true, result: "Pi quit before the run finished" };
				return run.stop(2_000);
			});
			await Promise.all(stopping);
			shared.pending.length = 0;
			shared.runs.clear();
			if (!readOnly) save();
			releaseLock();
			shared.lock = undefined; shared.lockPath = undefined;
			for (const lk of shared.folderLocks?.values() ?? []) lk.release();
			shared.folderLocks = undefined;
		}
		folderLock = undefined;
		ctx = undefined;
	});

	// In-conversation loops report through loop_report too: their next time, or that they are done.
	registerReportTool(pi, () => inConversation?.report ?? shared.away?.report);

	// -------------------------------------------------------------- command --

	pi.registerCommand("loop", {
		description: "Recurring prompts: /loop [10m|2h|1d|at HH:MM [Area/City]] <prompt> · /loop (the loops view) · /loop rm|pause|resume|run|test|watch|take|open|cancel <id> · /loop steer <id> <text> · /loop leave|done · /loop clear",
		handler: async (args: string, commandCtx?: ExtensionContext) => {
			await settledClaim();
			refreshZone();
			const trimmed = args.trim();
			const ui = commandCtx as any;
			if (!trimmed && ui?.ui?.custom && (ui.mode ?? ctx?.mode) === "tui") { await openView(ui); return; }
			if (!trimmed || trimmed === "list") { notify(listText()); return; }
			// Background runs: go in, come back, steer, stop.
			if (trimmed === "leave" || trimmed === "done") { const err = await leave(trimmed === "done", commandCtx); if (err) notify(err, "warning"); return; }
			{
				const [verb, target, ...more] = trimmed.split(/\s+/);
				if ((verb === "take" || verb === "open") && target && find(target) && (more.length === 0 || (more.length === 1 && more[0] === "now"))) {
					const err = await takeOver(target, more[0] === "now", commandCtx); if (err) notify(err, "warning"); return;
				}
				if (verb === "steer" && target && find(target) && more.length) { notify(await steerRun(target, trimmed.slice(trimmed.indexOf(target) + target.length).trim())); return; }
				if (verb === "cancel" && target && find(target) && !more.length) { notify(await cancelRun(target)); return; }
				if (verb === "watch" && target && find(target) && !more.length) {
					if (ui?.ui?.custom && (ui.mode ?? ctx?.mode) === "tui") { await openView(ui, find(target)!.id); return; }
					notify(runLines(find(target)!).slice(-30).join("\n") || "(nothing yet)"); return;
				}
			}
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
						const l = find(target)!; const err = fire(l, "manual"); notify(err ?? `fired ${l.id}`); return;
					}
				}
			}
			// --fork / --thread / --fresh (run in the background) and --for <duration> / --until <time>, among the schedule
			// words before the prompt; from the prompt's first word on, everything is the prompt.
			const words = trimmed.split(/\s+/);
			let run: RunMode | undefined; const life: { for?: string; until?: string } = {};
			const kept: string[] = [];
			let i = 0;
			for (; i < words.length; i++) {
				const w = words[i];
				if (/^--(fork|thread|fresh)$/.test(w)) { run = w.slice(2) as RunMode; continue; }
				if ((w === "--for" || w === "--until") && words[i + 1]) { life[w.slice(2) as "for" | "until"] = words[++i]; continue; }
				const first = !kept.length;
				if (first && (parseInterval(w) !== undefined || w.toLowerCase() === "auto")) { kept.push(w); continue; }
				if (first && w.toLowerCase() === "at" && words[i + 1]) {
					kept.push(w, words[++i]);
					if (words[i + 1] && (/\//.test(words[i + 1]) || /^utc$/i.test(words[i + 1]))) kept.push(words[++i]);
					continue;
				}
				break;
			}
			kept.push(...words.slice(i));
			const parsed = parseAdd(kept.join(" "));
			if ("error" in parsed) { notify(parsed.error, "warning"); return; }
			const ends = parseLifetime(life, Date.now());
			if (typeof ends === "string") { notify(ends, "warning"); return; }
			const r = add(parsed.schedule, parsed.prompt, undefined, parsed.tz, undefined, { run, expiresAt: ends });
			if (typeof r === "string") { notify(r, "warning"); return; }
			notify(`loop ${r.id}: ${desc(r)}${r.run ? `, in the background (${r.run})` : ""}, next ${when(r)}, ends ${fmtTime(r.expiresAt!, zoneOf(r))}. /loop rm ${r.id} to stop.`);
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
			"or test (run the gate once without waking). A loop's turn runs in this conversation, or (run) in the background as a fork of it, " +
			"its own thread or a fresh conversation, which the owner can watch, steer or go into with /loop. Every loop run ends with loop_report " +
			"(findings or not; optionally when to run next, or stop), so a self-paced loop (every: auto) chooses its own next time. Loops made here " +
			"end after 7 days unless for/until says otherwise. " +
			"`every` is a fixed interval (default 10m) or auto; `at` is a daily HH:MM wall-clock " +
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
			run: Type.Optional(Type.String({ description: "create: where each turn runs. Omit to run in this conversation. In the background: fork (a copy of this conversation as it is then), thread (the loop's own conversation, continued each run) or fresh (a new conversation each run). Background runs report through loop_report and stay quiet unless they find something." })),
			for: Type.Optional(Type.String({ description: "create: how long the loop lives, e.g. 2h, 3d (default 7d; loops that must last belong in .pi/loop.json)." })),
			until: Type.Optional(Type.String({ description: "create: when the loop ends, an ISO time with offset. Use either for or until." })),
		}),
		async execute(_toolCallId, p, _signal, _onUpdate, toolCtx) {
			await settledClaim();
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
							if (p.every?.trim().toLowerCase() === "auto") schedule = { kind: "auto" };
							else {
								const ms = p.every ? parseInterval(p.every) : DEFAULT_INTERVAL_MS;
								if (ms === undefined) throw new Error("every must look like 5m, 2h or 1d, or be auto");
								if (ms < MIN_INTERVAL_MS) throw new Error("minimum interval is 1m");
								schedule = { kind: "every", ms };
							}
						}
						if (p.run !== undefined && !RUN_MODES.includes(p.run as RunMode)) throw new Error("run must be fork, thread or fresh (or omitted, to run in this conversation)");
						const ends = parseLifetime({ for: p.for, until: p.until }, Date.now());
						if (typeof ends === "string") throw new Error(ends);
						const dir = insideDir(ctx!.cwd, p.dir?.trim());
						if (p.priority !== undefined && !Number.isFinite(p.priority)) throw new Error("priority must be a number");
						const r = add(schedule, p.prompt.trim(), p.id, tz, p.gate?.trim() ? gateConfig(p, dir) : undefined, { priority: p.priority, dir, context: contextFiles(p.context), run: p.run as RunMode | undefined, expiresAt: ends });
						if (typeof r === "string") throw new Error(r);
						const hints: string[] = [];
						const twins = loops.filter(l => l !== r && l.prompt === r.prompt);
						if (twins.length) hints.push(`loop ${twins.map(l => l.id).join(", ")} already sends this prompt; delete one unless both are intended`);
						if (!r.gate && r.schedule.kind === "every" && r.schedule.ms < 3_600_000) hints.push("no gate: every fire is a full model turn; for a frequent check, add one with action gate (see the pi-loop skill)");
						if (!r.prompt.startsWith("/")) hints.push("tip: a prompt template (.pi/prompts/<name>.md, prompt /<name>) keeps the instructions editable between fires");
						return `created loop ${r.id}: ${desc(r)}${r.run ? `, runs in the background (${r.run})` : ""}, next fire ${when(r)}, ends ${fmtTime(r.expiresAt!, zoneOf(r))}, catch-up ${r.catchUp}${r.gate ? `; ${gateText(r)}` : ""}${hints.map(h => `\n- ${h}`).join("")}`;
					}
				}
			})();
			return { content: [{ type: "text", text }], details: { loops } };
		},
	});
}
