/**
 * Runners: how a loop's background run is started.
 *
 *   rpc   (default) a hidden child Pi in RPC mode, driven over its pipe (background.ts)
 *   pi    an ordinary interactive Pi in a terminal: the run IS that session, you type straight into it
 *   <any> a runner described in settings (`loop.runners`): a command that starts an agent in a terminal, how
 *         the prompt reaches it, and its lifecycle hooks, which call bin/loop-run.mjs to tell the loop what
 *         it is doing (see RUNNERS.md). Nothing in pi-loop's core is specific to one agent.
 *
 * A terminal run never owns its terminal: pi-loop asks for one on `pi.events` (`loop:terminal`, v1) and some
 * other extension (pi-loop-herdr, or any multiplexer's) supplies it. What it runs there is `bin/loop-run.mjs start`
 * with only the run's channel folder and a one-time token: it fetches its environment and argv from this session
 * over a private socket (nothing of them is written to disk), records its pid, and execs the agent. One terminal per
 * attempt: when the run is recorded its agent has exited and its terminal is closed. The agent reports through the
 * channel (channel.ts), every event tagged with its attempt; the loop reads it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as net from "node:net";
import { randomBytes } from "node:crypto";
import { Run, lastAssistantText, piCommand, type RunMode } from "./background.ts";
import { Tail, makeChannel, sendCommand, removeChannel, scrubChannel } from "./channel.ts";

declare const __filename: string | undefined;
function here(): string {
	let source: string | undefined;
	try { source = fileURLToPath(import.meta.url); } catch { source = typeof __filename === "string" ? __filename : undefined; }
	if (!source) throw new Error("Couldn't locate pi-loop's runner files");
	return path.dirname(source);
}

/**
 * What a runner is. Built in: `rpc` and `pi`. Others come from settings (`loop.runners.<name>`) as JSON:
 *
 *   command   argv that starts the agent interactively; tokens are expanded (see expand())
 *   prompt    "argv": promptArgs carry it (the agent takes its first message on its command line);
 *             "channel": the agent's companion reads it from the channel (needs commands)
 *   promptArgs, model, modes.fresh|thread|fork: argv pieces; a mode that is null or absent can't be expressed,
 *             and runs as fresh, saying so
 *   files     files written into the channel before it starts (e.g. a hooks settings file), tokens expanded
 *   report    "tool": pi-loop's loop_report tool (a Pi); "cli": the run is told the command line to report with
 *   commands  it reads commands.jsonl (steer, abort, exit, decline a dialog); otherwise steering goes through
 *             the terminal (the provider's send), and a dialog nobody answers ends the run
 *   sessions  "pi": its session files are Pi's (watch, open, lastText); otherwise only what its hooks report
 */
export interface RunnerSpec {
	name: string;
	kind: "rpc" | "pi" | "command";
	command?: string[];
	prompt?: "argv" | "channel";
	promptArgs?: string[];
	model?: string[];
	modes?: Partial<Record<RunMode, string[] | null>>;
	files?: Record<string, unknown>;
	report?: "tool" | "cli";
	commands?: boolean;
	sessions?: "pi";
	/** No event at all for this long while it works: it is taken to hang, stopped and recorded failed. */
	stallMs?: number;
	/** A dialog left this long with nobody pressing a key is declined (or, without commands, ends the run). */
	dialogMs?: number;
}

export const DEFAULT_STALL_MS = 2 * 60 * 60_000;
export const DEFAULT_DIALOG_MS = 5 * 60_000;
export const RPC_RUNNER: RunnerSpec = { name: "rpc", kind: "rpc" };
const BUILTIN: Record<string, RunnerSpec> = {
	rpc: RPC_RUNNER,
	pi: { name: "pi", kind: "pi", prompt: "channel", report: "tool", commands: true, sessions: "pi" },
};

function parseMs(v: unknown): number | undefined {
	if (typeof v !== "string") return undefined;
	const m = /^(\d+)\s*(s|m|h|d)$/.exec(v.trim());
	return m ? Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s"] : undefined;
}

function timings(raw: any): Partial<RunnerSpec> {
	return { ...(parseMs(raw.stallAfter) ? { stallMs: parseMs(raw.stallAfter) } : {}), ...(parseMs(raw.dialogWait) ? { dialogMs: parseMs(raw.dialogWait) } : {}) };
}

/** A runner by name: built in, or `loop.runners.<name>` in the project's or agent's settings. Throws with what is wrong. */
export function resolveRunner(name: string, settingsFiles: string[]): RunnerSpec {
	if (BUILTIN[name]) {
		// A built-in runner takes only its timings from settings (loop.runners.pi: { stallAfter, dialogWait }).
		for (const file of settingsFiles) {
			let raw: any;
			try { raw = JSON.parse(fs.readFileSync(file, "utf8"))?.loop?.runners?.[name]; } catch { continue; }
			if (!raw || typeof raw !== "object") continue;
			return { ...BUILTIN[name], ...timings(raw) };
		}
		return BUILTIN[name];
	}
	for (const file of settingsFiles) {
		let raw: any;
		try { raw = JSON.parse(fs.readFileSync(file, "utf8"))?.loop?.runners?.[name]; } catch { continue; }
		if (raw === undefined) continue;
		if (!raw || typeof raw !== "object" || !Array.isArray(raw.command) || !raw.command.length || raw.command.some((x: unknown) => typeof x !== "string"))
			throw new Error(`loop.runners.${name} in ${file} needs command: the argv that starts it`);
		const prompt = raw.prompt === "channel" ? "channel" : "argv";
		if (prompt === "channel" && raw.commands !== true) throw new Error(`loop.runners.${name}: prompt "channel" needs commands: true (a companion that reads them)`);
		return { name, kind: "command", command: raw.command, prompt, promptArgs: Array.isArray(raw.promptArgs) ? raw.promptArgs : ["{prompt}"],
			...(Array.isArray(raw.model) ? { model: raw.model } : {}), modes: raw.modes && typeof raw.modes === "object" ? raw.modes : { fresh: [] },
			...(raw.files && typeof raw.files === "object" ? { files: raw.files } : {}), report: raw.report === "tool" ? "tool" : "cli",
			commands: raw.commands === true, ...(raw.sessions === "pi" ? { sessions: "pi" as const } : {}),
			...timings(raw) };
	}
	throw new Error(`no runner "${name}": the built-in ones are rpc and pi; others are described in loop.runners`);
}

/** The mode a runner gives a loop: its own, or fresh (with why) when it can't express it. */
export function modeFor(spec: RunnerSpec, mode: RunMode): { mode: RunMode; note?: string } {
	if (spec.kind !== "command") return { mode };
	if (Array.isArray(spec.modes?.[mode])) return { mode };
	return { mode: "fresh", note: `runner ${spec.name} can't run a ${mode} (${mode === "fork" ? "it can't continue this Pi conversation" : "it has no way to continue its own conversation"}), so it ran fresh` };
}

/**
 * How the run reports, for its prompt, when it has no loop_report tool: a command line. `keepsChecks`: the loop's
 * checks can't be postponed (a gate on a fixed schedule), so next only brings its next check forward.
 */
export function cliReportHint(spec: RunnerSpec, l: { gate?: unknown; schedule: { kind: string } }): string | undefined {
	if (spec.kind !== "command" || spec.report === "tool") return undefined;
	const keepsChecks = !!l.gate && l.schedule.kind !== "auto";
	return `When you finish, report once by running this shell command: node ${JSON.stringify(path.join(here(), "bin", "loop-run.mjs"))} report --findings <true|false> --summary "<one line>" ` +
		`[--ask "<the one thing the owner must do>"] [--next ${keepsChecks ? "2m" : "15m"}] [--stop]. findings true only if there is something the owner should see. ` +
		(keepsChecks ? "--next can only have this loop checked sooner than its schedule; its checks can't be postponed." : "--next chooses when this loop runs again.");
}

/** Thrown when no extension supplies a terminal (nothing listens to loop:terminal). */
export class NoTerminal extends Error {}

/** What a terminal provider hands back. Only `id` is required. */
export interface TerminalHandle {
	/** Where the run is, for people (e.g. "t7"). */
	id: string;
	/** Close the terminal (its program is ended first by pi-loop; this is for what is left). */
	close?(): Promise<void>;
	/** How a person gets to it, e.g. "hc attach t7". */
	attach?: string;
	/** Type text into it and press Enter (steering a runner that reads no commands). */
	send?(text: string): Promise<string | undefined>;
}

/** `loop:terminal` v1, op "open": sent when a terminal run starts. A provider calls `provide` synchronously. */
export interface TerminalRequest {
	v: 1; op: "open";
	loop: string; fire: number; attemptId: string; runner: string;
	name: string; title: string; description: string;
	/** The project whose session runs the loop, and the folder the run works in. */
	project: string; cwd: string;
	/** Start exactly this, in `cwd`. It carries no secrets: it fetches what it needs from this session once. */
	argv: string[];
	ready: Promise<void>;
	/** Variables (or prefixes ending in "*") the terminal sets itself, so the run's environment doesn't override them. */
	inherit: string[];
	provide(handle: Promise<TerminalHandle | undefined>): void;
}

/** Terminal identity every terminal sets for its own program. Providers add theirs through `inherit`. */
const TERMINAL_OWN = ["TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM", "COLUMNS", "LINES", "PI_PROGRAM_STATUS", "WINDOWID",
	"TMUX", "TMUX_PANE", "STY", "WEZTERM_PANE", "KITTY_WINDOW_ID", "ZELLIJ*", "HERDR_*", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE"];

const okName = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
function matches(k: string, pats: string[]) { return pats.some(p => p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : k === p); }

export function pidAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A process's start time (clock ticks since boot, /proc/<pid>/stat field 22), so a reused pid isn't taken for it. Undefined where /proc isn't. */
export function pidStart(pid: number | undefined): string | undefined {
	if (!pid) return undefined;
	try { const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return st.slice(st.lastIndexOf(")") + 2).split(" ")[19]; } catch { return undefined; }
}
/** The process `pid` that started at `start` is still running. */
export function sameProcess(pid: number | undefined, start: string | undefined): boolean {
	if (!pidAlive(pid)) return false;
	if (!start) return true;
	const now = pidStart(pid);
	return now === undefined || now === start;
}

/**
 * The one-time handoff: a run's launcher (bin/loop-run.mjs start, in its terminal) asks this session, over a private
 * socket, for its environment and argv with a single-use token. Nothing of them is written to disk; a token is
 * answered once, and forgotten after it is used, its run ends, or a minute passes.
 */
interface Handoff { env: Record<string, string>; argv: string[]; cwd: string; expires: number; onTaken(pid: number): void }
const HANDOFF = Symbol.for("pi-loop.runner.handoff.v1");
function handoffs(): { server?: net.Server; file?: string; offers: Map<string, Handoff> } {
	return ((globalThis as any)[HANDOFF] ??= { offers: new Map() });
}
/** Stop answering launchers (Pi is quitting): offers still open are dropped, their runs fail to start. */
export function closeHandoffs() {
	const h = handoffs();
	h.offers.clear();
	try { h.server?.close(); if (h.file) fs.rmSync(h.file, { force: true }); } catch { /* gone */ }
	h.server = undefined; h.file = undefined;
}
function handoffServer(dir: string): string {
	const h = handoffs();
	if (h.server && h.file && fs.existsSync(h.file)) return h.file;
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(dir, 0o700); } catch { /* not ours */ }
	const file = path.join(dir, `${process.pid}-runs.sock`);
	try { fs.rmSync(file, { force: true }); } catch { /* none */ }
	const server = net.createServer(sock => {
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("error", () => { /* the launcher went away */ });
		sock.on("data", (d: string) => {
			buf += d;
			const i = buf.indexOf("\n");
			if (i < 0) return;
			let req: any;
			try { req = JSON.parse(buf.slice(0, i)); } catch { sock.end(); return; }
			const offer = typeof req?.token === "string" ? h.offers.get(req.token) : undefined;
			if (offer) h.offers.delete(req.token);
			if (!offer || offer.expires < Date.now()) { sock.end(JSON.stringify({ error: "no such run (or it was already started)" }) + "\n"); return; }
			try { offer.onTaken(Number(req.pid) || 0); } catch { /* the run's problem */ }
			sock.end(JSON.stringify({ env: offer.env, argv: offer.argv, cwd: offer.cwd }) + "\n");
		});
	});
	server.on("error", () => { /* a failed listen: launches fail clearly, nothing else is affected */ });
	const old = process.umask(0o177);
	try { server.listen(file); } finally { process.umask(old); }
	server.unref();
	h.server = server; h.file = file;
	return file;
}

/** Persisted with the run's record before its terminal is asked for, so a later session can find (or rule out) it. */
export interface TerminalRef {
	runner: string; channel: string;
	/** The launcher's pid once it took its handoff (it execs the agent, so the agent's pid), and that process's start time. */
	pid?: number; pidStart?: string;
	terminal?: string; attach?: string;
	/** Where the prompt stood when last saved: not sent yet, sent (so maybe running), or taken (it said so). */
	dispatch?: "none" | "sent" | "accepted";
	/** Another agent's own session id, as its hooks reported it: a thread's next fire resumes it. */
	thread?: string;
}

/** What a run's channel says for one attempt, without following it: busy, last keys, exited. */
export function channelState(ref: TerminalRef, attemptId: string): { working: boolean; keysAt: number; exited: boolean; accepted: boolean } {
	let working = false, keysAt = 0, exited = false, accepted = false;
	for (const e of new Tail(path.join(ref.channel, "events.jsonl")).read()) {
		if (e.a !== attemptId) continue;
		if (e.e === "accepted" || e.e === "prompt") { accepted = true; working = true; }
		else if (e.e === "working") working = true;
		else if (e.e === "idle") working = false;
		else if (e.e === "keys" || e.e === "owner") keysAt = Number(e.at) || keysAt;
		else if (e.e === "exited") exited = true;
	}
	return { working, keysAt, exited, accepted };
}

/** End a terminal run's agent (its process group) and wait until it is gone; true once it is. */
export async function endProcess(ref: TerminalRef, attempt: string, graceMs = 5_000, channelCommands = false): Promise<boolean> {
	const alive = () => sameProcess(ref.pid, ref.pidStart);
	if (!alive()) return true;
	if (channelCommands) { try { sendCommand(ref.channel, { c: "exit", a: attempt }); } catch { /* gone */ } }
	const sig = (s: NodeJS.Signals) => { if (!alive()) return; try { process.kill(-ref.pid!, s); } catch { try { process.kill(ref.pid!, s); } catch { /* gone */ } } };
	const wait = async (ms: number) => { for (const end = Date.now() + ms; Date.now() < end && alive();) await new Promise(r => setTimeout(r, 100)); };
	await wait(channelCommands ? graceMs / 2 : 0);
	sig("SIGTERM"); await wait(graceMs / 2);
	sig("SIGKILL"); await wait(2_000);
	return !alive();
}

/** `loop:terminal` op "probe": does anything supply terminals? Providers call `here()` synchronously. */
export function terminalProvided(emit: (channel: string, data: object) => void): boolean {
	let found = false;
	try { emit("loop:terminal", { v: 1, op: "probe", here: () => { found = true; } }); } catch { /* a provider's problem */ }
	return found;
}

export interface TerminalOpts {
	cwd: string; sessionArgs: string[]; extra?: string[]; model?: string; thinking?: string; env: NodeJS.ProcessEnv; attemptId?: string;
	runner: RunnerSpec;
	/** Where its channel folder goes (one per attempt). */
	channelRoot: string;
	/** Where the handoff socket lives (private). */
	socketDir: string;
	/** The loop's prompt, for a runner that takes it on its command line. */
	text?: string;
	/** For the terminal request. */
	title: string; name: string; description: string; project: string;
	/** Emits on pi.events (the live session's bus). */
	emit(channel: string, data: object): void;
	/** Called (synchronously) whenever something it must find again after a restart changes: its ref. Saves the record. */
	persist(ref: TerminalRef): void;
	/** A thread's agent session id from its last run (another agent's resume id). */
	thread?: string;
}

/** How to run bin/loop-run.mjs with this very runtime: Node as it is, a compiled Pi (Bun) as Bun. */
function launcherCommand(): string[] {
	return (process.versions as any).bun ? ["env", "BUN_BE_BUN=1", process.execPath] : [process.execPath];
}

/** The longest a provider may take to open a terminal, and an agent to say it is up. */
const OPEN_TIMEOUT_MS = 20_000, START_TIMEOUT_MS = 90_000;

/**
 * A background run in a terminal. It behaves as a Run to the rest of pi-loop: acceptance, working and idle,
 * background work, the model it answered with, failures before work, steering, stopping. What it knows comes from
 * its channel, only from events tagged with its own attempt, never from a pipe.
 */
export class TerminalRun extends Run {
	/** What tells a terminal run apart across code-changing reloads (never `instanceof`). */
	readonly isTerminalRun = true;
	readonly runner: RunnerSpec;
	channel?: string;
	term?: TerminalHandle;
	/** The agent's pid (the launcher execs it) and that process's start time. */
	pid?: number;
	pidStart?: string;
	/** Its agent session id, as its hooks report it (another agent's thread). */
	thread?: string;
	private dispatch: "none" | "sent" | "accepted" = "none";
	private tail?: Tail;
	private timer?: ReturnType<typeof setInterval>;
	private started = false;
	private providers?: string[];
	private lastEventAt = Date.now();
	private dialog?: { title: string; since: number };
	private lastKeys = 0;
	private acceptWaiters: ((e: any) => void)[] = [];
	private startWaiters: ((e: any) => void)[] = [];
	private compacting = false;
	private token?: string;
	/** It closed itself (the owner quit it, or the loop asked it to), rather than crashed or was killed. */
	closedNormally = false;
	/** It was working when its process went away (rather than settled after the loop's prompt). */
	endedWorking = false;
	/** It settled at least once after taking the loop's prompt: the loop's turn finished. */
	settledOnce = false;
	private errorCounts = new Map<string, number>();
	private readonly topts: TerminalOpts;

	constructor(loopId: string, fire: number, mode: RunMode, opts: TerminalOpts) {
		super(loopId, fire, mode, opts);
		this.topts = opts;
		this.runner = opts.runner;
		this.thread = opts.thread;
	}

	/** Its record's pointer to the terminal (see TerminalRef). */
	get ref(): TerminalRef | undefined {
		return this.channel ? { runner: this.runner.name, channel: this.channel, ...(this.pid ? { pid: this.pid } : {}), ...(this.pidStart ? { pidStart: this.pidStart } : {}),
			...(this.term ? { terminal: this.term.id } : {}), ...(this.term?.attach ? { attach: this.term.attach } : {}), dispatch: this.dispatch, ...(this.thread ? { thread: this.thread } : {}) } : undefined;
	}
	get terminal(): string | undefined { return this.term?.id; }
	private save() { const r = this.ref; if (r) { try { this.topts.persist(r); } catch { /* the record's problem */ } } }

	private argv(): string[] {
		const spec = this.runner, o = this.topts;
		if (spec.kind === "pi") {
			const { cmd, args } = piCommand();
			const model = o.model ? ["--model", o.model, ...(o.thinking ? ["--thinking", o.thinking] : [])] : [];
			return [cmd, ...args, ...(o.extra ?? []), "-e", path.join(here(), "runner-pi.ts"), ...o.sessionArgs, ...model];
		}
		const vars: Record<string, string> = { channel: this.channel!, prompt: o.text ?? "", model: o.model ?? "", thinking: o.thinking ?? "",
			thread: this.thread ?? "", hook: `node ${JSON.stringify(path.join(here(), "bin", "loop-run.mjs"))}`, cwd: o.cwd };
		const expand = (xs: string[]) => xs.map(x => x.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k]! : m)));
		const modeArgs = this.mode === "thread" && !this.thread ? (spec.modes?.fresh ?? []) : (spec.modes?.[this.mode] ?? []);
		return [...expand(spec.command!), ...expand(modeArgs), ...(o.model && spec.model ? expand(spec.model) : []), ...(spec.prompt === "argv" ? expand(spec.promptArgs ?? ["{prompt}"]) : [])];
	}

	/** The run's environment for its launcher (never written to disk). */
	private env(inherit: string[]): Record<string, string> {
		const skip = [...TERMINAL_OWN, ...inherit];
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries({ ...this.topts.env, PI_LOOP_CHANNEL: this.channel!, PI_LOOP_ATTEMPT: this.attemptId, PI_LOOP_HOST: String(process.pid) }))
			if (typeof v === "string" && okName(k) && !matches(k, skip)) out[k] = v;
		return out;
	}

	/** Files a runner described in settings writes into its channel (e.g. a hooks config): no secrets go in them. */
	private writeFiles() {
		const hookCmd = `node ${JSON.stringify(path.join(here(), "bin", "loop-run.mjs"))}`;
		for (const [name, body] of Object.entries(this.runner.files ?? {})) {
			const text = JSON.stringify(body).replace(/\{hook\}/g, JSON.stringify(hookCmd).slice(1, -1)).replace(/\{channel\}/g, JSON.stringify(this.channel!).slice(1, -1));
			fs.writeFileSync(path.join(this.channel!, path.basename(name)), text, { mode: 0o600 });
		}
	}

	/**
	 * Ask for a terminal and start the agent in it. Its channel and ref are saved (persist) before the terminal is
	 * asked for, and again once its launcher has taken its handoff (its pid): a session that stops anywhere in
	 * between finds the attempt and ends or follows it.
	 */
	override async start(): Promise<void> {
		this.channel = makeChannel(path.join(this.topts.channelRoot, this.attemptId));
		this.tail = new Tail(path.join(this.channel, "events.jsonl"));
		this.save();
		let markReady!: () => void;
		const ready = new Promise<void>(r => { markReady = r; });
		const offers: Promise<TerminalHandle | undefined>[] = [];
		const launcher = path.join(here(), "bin", "loop-run.mjs");
		this.token = randomBytes(24).toString("hex");
		const req: TerminalRequest = {
			v: 1, op: "open", loop: this.loopId, fire: this.fire, attemptId: this.attemptId, runner: this.runner.name,
			name: this.topts.name, title: this.topts.title, description: this.topts.description, project: this.topts.project, cwd: this.cwd,
			argv: [...launcherCommand(), launcher, "start", this.channel], ready, inherit: [],
			provide: h => { offers.push(Promise.resolve(h).catch(() => undefined)); },
		};
		this.topts.emit("loop:terminal", req);
		if (!offers.length) throw new NoTerminal("no terminal provider: nothing on pi.events supplies terminals (loop:terminal), e.g. pi-loop-herdr");
		this.writeFiles();
		const sock = handoffServer(this.topts.socketDir);
		// The launcher reads the socket and token from a file only it can read, removed as it reads it.
		fs.writeFileSync(path.join(this.channel, "start"), JSON.stringify({ socket: sock, token: this.token, attempt: this.attemptId }), { mode: 0o600 });
		handoffs().offers.set(this.token, { env: this.env(req.inherit), argv: this.argv(), cwd: this.cwd, expires: Date.now() + OPEN_TIMEOUT_MS + START_TIMEOUT_MS,
			onTaken: pid => { this.pid = pid || this.pid; this.pidStart = pidStart(this.pid); if (this.runner.prompt === "argv") { this.dispatch = "sent"; this.promptDispatched = true; } this.save(); } });
		markReady();
		this.timer = setInterval(() => this.poll(), 250);
		this.timer.unref?.();
		let t: ReturnType<typeof setTimeout> | undefined;
		const handle = await Promise.race([Promise.any(offers.map(o => o.then(h => h ?? Promise.reject()))).catch(() => undefined), new Promise<undefined>(r => { t = setTimeout(() => r(undefined), OPEN_TIMEOUT_MS); })]);
		if (t) clearTimeout(t);
		if (handle) { this.term = handle; this.save(); }
		// A provider that never answered may still have started the launcher: its pid (from the handoff) is what counts.
		if (!handle && !this.pid) throw new Error("the terminal provider didn't open a terminal for the run");
		const up = await this.until(this.startWaiters, () => this.started, START_TIMEOUT_MS);
		if (!up) throw new Error(this.exited ? `its ${this.runner.name} exited before it started` : `its ${this.runner.name} didn't say it started within ${START_TIMEOUT_MS / 1000}s`);
	}

	/**
	 * Follow a run an earlier session of the loop left in its terminal (it outlives that session), reading its channel
	 * for this attempt only, from the start: a run that finished meanwhile is recorded from what it said.
	 */
	adopt(ref: TerminalRef, session?: string) {
		this.channel = ref.channel; this.pid = ref.pid; this.pidStart = ref.pidStart; this.dispatch = ref.dispatch ?? "none"; this.thread = ref.thread ?? this.thread;
		if (session) this.sessionFile = session;
		this.term = ref.terminal ? { id: ref.terminal, ...(ref.attach ? { attach: ref.attach } : {}) } : undefined;
		this.tail = new Tail(path.join(ref.channel, "events.jsonl"));
		this.started = true;
		this.promptDispatched = this.dispatch !== "none";
		if (this.dispatch === "accepted") this.promptAccepted = true;
		this.poll();
		// Sent but not seen taken yet: it is on its way (or hangs, which the stall check catches).
		if (this.promptDispatched && !this.exited && !this.settledOnce) this.working = true;
		if (!this.exited) { this.timer = setInterval(() => this.poll(), 250); this.timer.unref?.(); }
	}

	private until(list: ((e: any) => void)[], done: () => boolean, ms: number): Promise<boolean> {
		if (done()) return Promise.resolve(true);
		return new Promise(resolve => {
			const t = setTimeout(() => { const i = list.indexOf(w); if (i >= 0) list.splice(i, 1); resolve(done()); }, ms);
			const w = () => { if (done() || this.exited) { clearTimeout(t); const i = list.indexOf(w); if (i >= 0) list.splice(i, 1); resolve(done()); } };
			list.push(w);
		});
	}

	private poll() {
		for (const e of this.tail?.read() ?? []) this.event(e);
		const now = Date.now();
		if (!this.exited && this.pid && !sameProcess(this.pid, this.pidStart)) { this.markExited(); }
		if (this.exited) { this.stopTimer(); return; }
		const dialogMs = this.runner.dialogMs ?? DEFAULT_DIALOG_MS;
		if (this.dialog && now - Math.max(this.dialog.since, this.lastKeys) > dialogMs) this.declineDialog();
		const stallMs = this.runner.stallMs ?? DEFAULT_STALL_MS;
		// Bounded whatever it waits on: its turn, its prompt, or detached work it says it still owns. Typing counts as life.
		const waiting = this.working || this.backgroundWork || (this.promptDispatched && !this.promptAccepted);
		if (waiting && !this.dialog && !this.compacting && !this.livenessError && now - Math.max(this.lastEventAt, this.lastKeys) > stallMs) {
			this.livenessError = `no sign of progress from its ${this.runner.name} for ${Math.round(stallMs / 60_000)}m; stopped`;
			void this.stop();
			this.changed();
		}
	}

	private stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

	private wake(list: ((e: any) => void)[], e: any) { for (const w of list.slice()) w(e); }

	private event(e: any) {
		if (!e || typeof e.e !== "string") return;
		// Only this attempt's events (the launcher's spawned/exited carry it too); anything else is not ours.
		if (e.a !== this.attemptId) return;
		this.lastEventAt = Date.now();
		switch (e.e) {
			case "spawned": if (!this.pid) { this.pid = Number(e.pid) || undefined; this.pidStart = pidStart(this.pid); } break;
			case "started":
				this.started = true;
				if (this.runner.sessions === "pi" && typeof e.session === "string") this.sessionFile = e.session;
				if (typeof e.session_id === "string" && e.session_id && e.session_id !== this.thread) { this.thread = e.session_id; this.save(); }
				if (Array.isArray(e.providers)) this.providers = e.providers.filter((x: unknown) => typeof x === "string");
				this.wake(this.startWaiters, e);
				break;
			case "providers": if (Array.isArray(e.providers)) this.providers = e.providers.filter((x: unknown) => typeof x === "string"); break;
			case "accepted":
				this.accept(e.disposition === "handled" ? "handled" : "started");
				this.wake(this.acceptWaiters, e);
				break;
			case "refused": this.wake(this.acceptWaiters, e); break;
			// A runner that takes its prompt on its command line says so from its prompt hook (e.g. UserPromptSubmit).
			case "prompt":
				if (!this.promptAccepted) { this.accept("started"); this.wake(this.acceptWaiters, e); }
				else if (!this.working) { this.working = true; this.starts++; this.changed(); }
				break;
			case "working": this.dialogHeld = false; this.starts++; if (!this.working) { this.working = true; this.changed(); } break;
			case "idle":
				if (this.promptDispatched && !this.promptAccepted) break; // its first turn hasn't been seen to start
				if (this.promptAccepted) this.settledOnce = true;
				this.settle();
				break;
			case "background":
				this.backgroundWork = e.status === "busy";
				if (e.status === "error") this.livenessError = "Couldn't establish whether the run still owns background work";
				this.changed();
				break;
			case "answer": {
				const stop = e.stop;
				this.modelFailure = stop === "error" ? "model_error" : stop === "aborted" ? "model_aborted" : undefined;
				if (typeof e.model === "string" && e.model) this.reportedModel = e.model;
				if (e.content) this.didWork = true;
				// Pi retries only errors it judges transient, each as a new answer: the same error (by its digest) answered
				// again with nothing in between means Pi retried it, and an idle after that means it gave up.
				if (stop === "error") {
					const k = String(e.err ?? "?"), n = (this.errorCounts.get(k) ?? 0) + 1;
					this.errorCounts.clear(); this.errorCounts.set(k, n);
					this.gaveUpRetrying = n >= 2;
				} else { this.errorCounts.clear(); this.gaveUpRetrying = false; }
				break;
			}
			case "extension_error": this.extensionFailed = true; this.changed(); break;
			case "tool": this.didWork = true; break;
			case "compaction": this.compacting = e.phase === "start"; break;
			// A dialog holds the run open (a command waiting on it hasn't finished), until it is answered or declined.
			case "dialog":
				this.dialog = { title: typeof e.title === "string" ? e.title : "a question", since: Date.now() };
				if (!this.working) { this.working = true; this.dialogHeld = true; }
				this.changed();
				break;
			case "dialog_end": this.dialog = undefined; this.releaseDialog(); this.changed(); break;
			case "declined": this.needsYou ??= `dialog: ${typeof e.title === "string" ? e.title.slice(0, 120) : "a question"}`; break;
			case "keys": this.lastKeys = Date.now(); break;
			case "owner": this.lastKeys = Date.now(); this.didWork = true; this.changed(); break;
			case "exit": this.closedNormally = true; break;
			case "exited": this.markExited(); break;
		}
	}

	private accept(disposition: "started" | "handled") {
		if (this.promptAccepted && this.dispatch === "accepted") return;
		this.promptAccepted = true;
		this.disposition = disposition;
		this.dispatch = "accepted";
		this.save();
		if (disposition === "started") { this.working = true; this.starts++; this.changed(); }
		else this.settleUnlessStarted(this.starts);
	}

	private dialogHeld = false;
	/** A dialog open in it holds the run: it settles once the dialog is answered or declined. */
	protected override settle() { if (this.dialog) return; super.settle(); }
	private releaseDialog() { if (this.dialogHeld) { this.dialogHeld = false; this.settleUnlessStarted(this.starts); } }

	private declineDialog() {
		const d = this.dialog!;
		this.dialog = undefined;
		this.releaseDialog();
		this.needsYou = `dialog: ${d.title.slice(0, 120)}`;
		this.push([`  ! nobody answered a dialog (needs you): ${d.title.slice(0, 100)}`]);
		if (this.runner.commands) { try { sendCommand(this.channel!, { c: "decline", a: this.attemptId }); } catch { /* gone */ } return; }
		// Nothing can answer it for this agent: the run ends here, and says what it needed.
		this.livenessError = `nobody answered its dialog within ${Math.round((this.runner.dialogMs ?? DEFAULT_DIALOG_MS) / 60_000)}m; stopped`;
		void this.stop();
	}

	protected override markExited() {
		if (this.exited) return;
		this.stopTimer();
		for (const e of this.tail?.read() ?? []) if (e?.e !== "exited") this.event(e);
		this.endedWorking = this.working || (this.promptDispatched && !this.promptAccepted);
		if (this.token) { handoffs().offers.delete(this.token); this.token = undefined; }
		super.markExited();
		this.wake(this.startWaiters, {}); this.wake(this.acceptWaiters, {});
	}

	/** Credentials: Pi's companion says which providers it has them for. */
	override async listsCredentials(): Promise<boolean> {
		const model = this.model ?? "", slash = model.indexOf("/");
		if (slash <= 0 || !this.providers) return true;
		if (this.providers.includes(model.slice(0, slash))) return true;
		// Pi fills its list in the background: its companion says again after a moment.
		await new Promise(r => setTimeout(r, 3_000));
		this.poll();
		return this.providers.includes(model.slice(0, slash));
	}

	/**
	 * Hand it the loop's prompt (or, for a runner that took it on its command line, see that it took it). `sent` is
	 * saved before the command is written, so a session that stops right after knows it may be running.
	 */
	override async prompt(text: string): Promise<void> {
		if (this.runner.prompt === "channel") {
			this.dispatch = "sent"; this.promptDispatched = true;
			this.save();
			const file = path.join(this.channel!, `prompt-${this.attemptId}.txt`);
			fs.writeFileSync(file, text, { mode: 0o600 });
			sendCommand(this.channel!, { c: "prompt", a: this.attemptId, file });
		}
		this.push([`› ${text.split("\n")[0]!.slice(0, 200)}`]);
		// Accepted once it says so. While it shows signs of life (compaction, preparing) it is given longer.
		const cap = Date.now() + 10 * 60_000;
		for (;;) {
			const seen = this.lastEventAt;
			let refused: any;
			const got = await new Promise<boolean>(resolve => {
				const t = setTimeout(() => { const i = this.acceptWaiters.indexOf(w); if (i >= 0) this.acceptWaiters.splice(i, 1); resolve(false); }, 30_000);
				const w = (e: any) => { if (e?.e === "refused") refused = e; if (!(this.promptAccepted || refused || this.exited)) return; clearTimeout(t); const i = this.acceptWaiters.indexOf(w); if (i >= 0) this.acceptWaiters.splice(i, 1); resolve(true); };
				if (this.promptAccepted || this.exited) { clearTimeout(t); resolve(true); return; }
				this.acceptWaiters.push(w);
			});
			if (this.promptAccepted) return;
			if (refused) {
				// Refused by its companion before it was sent on (it checked first): nothing ran.
				this.promptDispatched = false; this.dispatch = "none"; this.save();
				throw new Error(String(refused.why ?? "it refused the prompt"));
			}
			if (this.exited) { this.promptUncertain = true; throw new Error(`its ${this.runner.name} exited before it took the prompt`); }
			if (!got && ((this.lastEventAt === seen && !this.compacting) || Date.now() > cap)) { this.promptUncertain = true; throw new Error(`no sign that its ${this.runner.name} took the prompt`); }
		}
	}

	override async steer(text: string): Promise<string | undefined> {
		this.didWork = true;
		if (this.runner.commands && this.channel) {
			try { sendCommand(this.channel, { c: "say", a: this.attemptId, text }); } catch (e) { return (e as Error).message; }
			if (!this.working) { this.working = true; this.changed(); }
			this.push([`› (you) ${text.slice(0, 200)}`]);
			return undefined;
		}
		if (this.term?.send) return this.term.send(text);
		return `it runs in a terminal${this.term ? ` (${this.term.id})` : ""}; type there`;
	}

	override async lastText(): Promise<string | undefined> {
		return this.sessionFile ? lastAssistantText(this.sessionFile) : undefined;
	}

	override async abort(): Promise<void> {
		if (this.runner.commands && this.channel) { try { sendCommand(this.channel, { c: "abort", a: this.attemptId }); } catch { /* gone */ } }
	}

	/** End its agent and wait until it is gone, then have the provider close what is left of its terminal. */
	override async stop(graceMs = 5_000): Promise<void> {
		if (this.token) { handoffs().offers.delete(this.token); this.token = undefined; }
		if (!this.exited) {
			const ref = this.ref;
			if (ref?.pid) await endProcess(ref, this.attemptId, graceMs, !!this.runner.commands);
			if (this.pid && sameProcess(this.pid, this.pidStart)) return; // couldn't end it: still followed, said by whoever stops it
			this.markExited();
		}
		// Gone: what its channel held beyond the record goes (prompt, commands, start file), then its terminal.
		if (this.channel) scrubChannel(this.channel);
		const term = this.term;
		this.term = term ? { id: term.id, ...(term.attach ? { attach: term.attach } : {}) } : undefined;
		try { await term?.close?.(); } catch { /* gone */ }
	}

	/** Stop following it without ending it: the session that follows it is going away, the next one picks it up. */
	detach() { this.stopTimer(); if (this.token) { handoffs().offers.delete(this.token); this.token = undefined; } }

	/** Its agent is gone (ended or never started): its channel's secrets-bearing files can go, the record remains. */
	get gone(): boolean { return !this.pid ? this.exited : !sameProcess(this.pid, this.pidStart); }
}

export { removeChannel };
