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
 * other extension (pi-loop-herdr, or any multiplexer's) supplies it. What runs in it is a small shell script in
 * the run's private channel folder (channel.ts): it loads the run's environment, records its pid, runs the agent
 * in the foreground and records its exit. The agent reports through the channel; the loop reads it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Run, lastAssistantText, piCommand, type RunMode } from "./background.ts";
import { CHANNEL_ENV, Tail, makeChannel, sendCommand } from "./channel.ts";

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
	/** After its run is recorded, its session stays open in its terminal (to read, or carry on) this long untouched; 0 closes it at once. */
	keepMs?: number;
}

export const DEFAULT_STALL_MS = 2 * 60 * 60_000;
export const DEFAULT_DIALOG_MS = 5 * 60_000;
export const DEFAULT_KEEP_MS = 30 * 60_000;
const BUILTIN: Record<string, RunnerSpec> = {
	rpc: { name: "rpc", kind: "rpc" },
	pi: { name: "pi", kind: "pi", prompt: "channel", report: "tool", commands: true, sessions: "pi" },
};

function parseMs(v: unknown): number | undefined {
	if (typeof v !== "string") return undefined;
	const m = /^(\d+)\s*(s|m|h|d)$/.exec(v.trim());
	return m ? Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s"] : undefined;
}

function timings(raw: any): Partial<RunnerSpec> {
	const keep = raw.keepOpen === false || raw.keepOpen === "0" ? 0 : parseMs(raw.keepOpen);
	return { ...(parseMs(raw.stallAfter) ? { stallMs: parseMs(raw.stallAfter) } : {}), ...(parseMs(raw.dialogWait) ? { dialogMs: parseMs(raw.dialogWait) } : {}),
		...(keep !== undefined ? { keepMs: keep } : {}) };
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
	/** Start exactly this, in `cwd`, once `ready` resolves. It carries its own environment (a private file). */
	argv: string[];
	ready: Promise<void>;
	/** Variables (or prefixes ending in "*") the terminal sets itself, so the run's environment doesn't override them. */
	inherit: string[];
	provide(handle: Promise<TerminalHandle | undefined>): void;
}

/** Terminal identity every terminal sets for its own program. Providers add theirs through `inherit`. */
const TERMINAL_OWN = ["TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM", "COLUMNS", "LINES", "PI_PROGRAM_STATUS", "WINDOWID",
	"TMUX", "TMUX_PANE", "STY", "WEZTERM_PANE", "KITTY_WINDOW_ID", "ZELLIJ*", "HERDR_*", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE"];

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const okName = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
function matches(k: string, pats: string[]) { return pats.some(p => p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : k === p); }

export function pidAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export interface TerminalOpts {
	cwd: string; sessionArgs: string[]; extra?: string[]; model?: string; thinking?: string; env: NodeJS.ProcessEnv; attemptId?: string;
	runner: RunnerSpec;
	/** Where its channel folder goes (one per attempt). */
	channelRoot: string;
	/** The loop's prompt, for a runner that takes it on its command line. */
	text?: string;
	/** For the terminal request. */
	title: string; name: string; description: string; project: string;
	/** Emits on pi.events (the live session's bus). */
	emit(channel: string, data: object): void;
	/** Its terminal's own conversation id from its last run (thread). */
	thread?: string;
}

/** Persisted with the run's record, so a later session can find a run still going in its terminal. */
export interface TerminalRef { runner: string; channel: string; pid?: number; terminal?: string; attach?: string; thread?: string }

/** What a run's channel says so far, without following it: is its agent busy, did someone type lately, is it gone. */
export function channelState(ref: TerminalRef): { working: boolean; keysAt: number; alive: boolean } {
	let working = false, keysAt = 0, exited = false;
	for (const e of new Tail(path.join(ref.channel, "events.jsonl")).read()) {
		if (e.e === "working" || e.e === "prompt") working = true;
		else if (e.e === "idle") working = false;
		else if (e.e === "keys" || e.e === "owner") keysAt = Number(e.at) || keysAt;
		else if (e.e === "exited") exited = true;
	}
	return { working, keysAt, alive: !exited && pidAlive(ref.pid) };
}

/**
 * Close a session the loop kept open after its run (it is the owner's to use meanwhile): ask it to quit, then end its
 * process group. Only when nobody typed into it for `quietMs` and it isn't working. Returns whether it is gone.
 */
export async function closeKept(ref: TerminalRef, quietMs: number): Promise<boolean> {
	const st = channelState(ref);
	if (!st.alive) return true;
	if (st.working || Date.now() - st.keysAt < quietMs) return false;
	try { sendCommand(ref.channel, { c: "exit" }); } catch { /* gone */ }
	for (let i = 0; i < 20 && pidAlive(ref.pid); i++) await new Promise(r => setTimeout(r, 250));
	if (ref.pid && pidAlive(ref.pid)) { try { process.kill(-ref.pid, "SIGTERM"); } catch { try { process.kill(ref.pid, "SIGTERM"); } catch { /* gone */ } } }
	return true;
}

/** `loop:terminal` op "probe": does anything supply terminals? Providers call `here()` synchronously. */
export function terminalProvided(emit: (channel: string, data: object) => void): boolean {
	let found = false;
	try { emit("loop:terminal", { v: 1, op: "probe", here: () => { found = true; } }); } catch { /* a provider's problem */ }
	return found;
}

/**
 * A background run in a terminal. It behaves as a Run to the rest of pi-loop: acceptance, working and idle,
 * background work, the model it answered with, failures before work, steering, stopping. What it knows comes from
 * its channel, never from a pipe: the terminal belongs to the person looking at it.
 */
export class TerminalRun extends Run {
	readonly runner: RunnerSpec;
	channel?: string;
	term?: TerminalHandle;
	/** The shell that runs the agent (its foreground process group). */
	pid?: number;
	/** The agent's own conversation id (thread), as its hooks report it. */
	thread?: string;
	private tail?: Tail;
	private timer?: ReturnType<typeof setInterval>;
	private started = false;
	private providers?: string[];
	private lastEventAt = Date.now();
	private dialog?: { title: string; since: number };
	private lastKeys = 0;
	private lastText_?: string;
	private acceptWaiters: ((e: any) => void)[] = [];
	private startWaiters: ((e: any) => void)[] = [];
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
		return this.channel ? { runner: this.runner.name, channel: this.channel, ...(this.pid ? { pid: this.pid } : {}), ...(this.term ? { terminal: this.term.id } : {}),
			...(this.term?.attach ? { attach: this.term.attach } : {}), ...(this.thread ? { thread: this.thread } : {}) } : undefined;
	}
	get terminal(): string | undefined { return this.term?.id; }

	private argv(): string[] {
		const spec = this.runner, o = this.topts;
		if (spec.kind === "pi") {
			const { cmd, args } = piCommand();
			const model = o.model ? ["--model", o.model, ...(o.thinking ? ["--thinking", o.thinking] : [])] : [];
			return [cmd, ...args, ...(o.extra ?? []), "-e", path.join(here(), "runner-pi.ts"), ...o.sessionArgs, ...model];
		}
		const vars: Record<string, string> = { channel: this.channel!, prompt: o.text ?? "", model: o.model ?? "", thinking: o.thinking ?? "",
			thread: this.thread ?? "", hook: `node ${q(path.join(here(), "bin", "loop-run.mjs"))}`, cwd: o.cwd };
		const expand = (xs: string[]) => xs.map(x => x.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k]! : m)));
		const modeArgs = this.mode === "thread" && !this.thread ? (spec.modes?.fresh ?? []) : (spec.modes?.[this.mode] ?? []);
		return [...expand(spec.command!), ...expand(modeArgs), ...(o.model && spec.model ? expand(spec.model) : []), ...(spec.prompt === "argv" ? expand(spec.promptArgs ?? ["{prompt}"]) : [])];
	}

	private writeFiles(inherit: string[]) {
		const dir = this.channel!, env = { ...this.topts.env, [CHANNEL_ENV]: dir, PI_LOOP_HOST: String(process.pid) };
		const skip = [...TERMINAL_OWN, ...inherit];
		const lines = Object.entries(env).filter(([k, v]) => typeof v === "string" && okName(k) && !matches(k, skip)).map(([k, v]) => `export ${k}=${q(v as string)}`);
		fs.writeFileSync(path.join(dir, "env.sh"), lines.join("\n") + "\n", { mode: 0o600 });
		const hookCmd = `node ${q(path.join(here(), "bin", "loop-run.mjs"))}`;
		for (const [name, body] of Object.entries(this.runner.files ?? {})) {
			const text = JSON.stringify(body).replace(/\{hook\}/g, JSON.stringify(hookCmd).slice(1, -1)).replace(/\{channel\}/g, JSON.stringify(dir).slice(1, -1));
			fs.writeFileSync(path.join(dir, path.basename(name)), text, { mode: 0o600 });
		}
		const argv = this.argv();
		const ev = `${q(path.join(dir, "events.jsonl"))}`;
		fs.writeFileSync(path.join(dir, "run.sh"), [
			"#!/bin/sh",
			`# pi-loop: ${this.topts.title} (runner ${this.runner.name}). Its environment is in env.sh beside this file.`,
			`. ${q(path.join(dir, "env.sh"))} && rm -f ${q(path.join(dir, "env.sh"))}`,
			`printf '{"e":"spawned","pid":%s,"at":%s000}\\n' "$$" "$(date +%s)" >> ${ev}`,
			// exec: the agent keeps this pid, so the loop sees its exit and can end it (and what it started) as one group.
			`exec ${argv.map(q).join(" ")}`,
		].join("\n") + "\n", { mode: 0o700 });
	}

	/** Ask for a terminal, start the agent in it, and wait until it says it is up. */
	override async start(): Promise<void> {
		this.channel = makeChannel(path.join(this.topts.channelRoot, this.attemptId));
		this.tail = new Tail(path.join(this.channel, "events.jsonl"));
		let markReady!: () => void;
		const ready = new Promise<void>(r => { markReady = r; });
		const offers: Promise<TerminalHandle | undefined>[] = [];
		const req: TerminalRequest = {
			v: 1, op: "open", loop: this.loopId, fire: this.fire, attemptId: this.attemptId, runner: this.runner.name,
			name: this.topts.name, title: this.topts.title, description: this.topts.description, project: this.topts.project, cwd: this.cwd,
			argv: ["sh", path.join(this.channel, "run.sh")], ready, inherit: [],
			provide: h => { offers.push(Promise.resolve(h).catch(() => undefined)); },
		};
		this.topts.emit("loop:terminal", req);
		if (!offers.length) throw new NoTerminal("no terminal provider: nothing on pi.events supplies terminals (loop:terminal), e.g. pi-loop-herdr");
		this.writeFiles(req.inherit);
		markReady();
		let t: ReturnType<typeof setTimeout> | undefined;
		const handle = await Promise.race([Promise.any(offers.map(o => o.then(h => h ?? Promise.reject()))).catch(() => undefined), new Promise<undefined>(r => { t = setTimeout(() => r(undefined), 20_000); })]);
		if (t) clearTimeout(t);
		if (!handle) throw new Error("the terminal provider didn't open a terminal for the run");
		this.term = handle;
		// A runner that takes its prompt on its command line has it from the start.
		if (this.runner.prompt === "argv") this.promptDispatched = true;
		this.timer = setInterval(() => this.poll(), 250);
		this.timer.unref?.();
		const up = await this.until(this.startWaiters, () => this.started, 90_000);
		if (!up) throw new Error(this.exited ? `its ${this.runner.name} exited before it started` : `its ${this.runner.name} didn't say it started within 90s`);
	}

	/**
	 * Pick up a run already in a terminal: one an earlier session of the loop left going (`replay`: read its channel
	 * from the start, so a run that finished meanwhile is seen to), or a thread's live session given its next fire.
	 */
	attach(ref: TerminalRef, replay: boolean, session?: string, handle?: TerminalHandle) {
		this.channel = ref.channel; this.pid = ref.pid; this.thread = ref.thread;
		if (session) this.sessionFile = session;
		this.term = handle ?? (ref.terminal ? { id: ref.terminal, ...(ref.attach ? { attach: ref.attach } : {}) } : undefined);
		this.tail = new Tail(path.join(ref.channel, "events.jsonl"));
		this.started = true;
		if (!replay) this.tail.read();
		else this.promptDispatched = true;
		this.poll();
		// Picked up before it was seen to take its prompt: it is still on its way (or hangs, which the stall check catches).
		if (replay && !this.promptAccepted && !this.exited) this.working = true;
		this.timer = setInterval(() => this.poll(), 250);
		this.timer.unref?.();
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
		if (!this.exited && this.pid && !pidAlive(this.pid)) { this.markExited(); }
		if (this.exited) { this.stopTimer(); return; }
		const dialogMs = this.runner.dialogMs ?? DEFAULT_DIALOG_MS;
		if (this.dialog && now - Math.max(this.dialog.since, this.lastKeys) > dialogMs) this.declineDialog();
		const stallMs = this.runner.stallMs ?? DEFAULT_STALL_MS;
		if ((this.working || (this.promptDispatched && !this.promptAccepted)) && !this.dialog && now - Math.max(this.lastEventAt, this.lastKeys) > stallMs) {
			this.livenessError = `no sign of progress from its ${this.runner.name} for ${Math.round(stallMs / 60_000)}m; stopped`;
			void this.stop();
			this.changed();
		}
	}

	/** Stop following it without ending it (another TerminalRun has taken it over). */
	release() { this.stopTimer(); }

	private stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

	private wake(list: ((e: any) => void)[], e: any) { for (const w of list.slice()) w(e); }

	private event(e: any) {
		if (!e || typeof e.e !== "string") return;
		this.lastEventAt = Date.now();
		switch (e.e) {
			case "spawned": this.pid = Number(e.pid) || this.pid; break;
			case "started":
				this.started = true;
				if (this.runner.sessions === "pi" && typeof e.session === "string") this.sessionFile = e.session;
				if (typeof e.session_id === "string" && e.session_id) this.thread = e.session_id;
				if (Array.isArray(e.providers)) this.providers = e.providers.filter((x: unknown) => typeof x === "string");
				this.wake(this.startWaiters, e);
				break;
			case "providers": if (Array.isArray(e.providers)) this.providers = e.providers.filter((x: unknown) => typeof x === "string"); break;
			case "accepted":
				this.promptAccepted = true;
				this.disposition = e.disposition === "handled" ? "handled" : "started";
				if (this.disposition === "started") { this.working = true; this.starts++; this.changed(); }
				else this.settleUnlessStarted(this.starts);
				this.wake(this.acceptWaiters, e);
				break;
			case "refused": this.wake(this.acceptWaiters, e); break;
			// A runner that takes its prompt on its command line says so from its prompt hook (e.g. UserPromptSubmit).
			case "prompt":
				if (!this.promptAccepted) { this.promptAccepted = true; this.disposition = "started"; this.working = true; this.starts++; this.changed(); this.wake(this.acceptWaiters, e); }
				else if (!this.working) { this.working = true; this.starts++; this.changed(); }
				break;
			case "working": this.dialogHeld = false; this.starts++; if (!this.working) { this.working = true; this.changed(); } break;
			case "idle":
				if (typeof e.text === "string" && e.text.trim()) this.lastText_ = e.text;
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
				if (typeof e.text === "string" && e.text.trim()) this.lastText_ = e.text;
				// Pi retries only errors it judges transient: the same error answered again means it was retried.
				// Pi retries only errors it judges transient, each as a new answer: the same error answered again, with
				// nothing in between, means Pi retried it, and an idle after that means it gave up.
				if (stop === "error") {
					const msg = String(e.error ?? "Unknown error"), n = (this.errorCounts.get(msg) ?? 0) + 1;
					this.errorCounts.clear(); this.errorCounts.set(msg, n);
					this.gaveUpRetrying = n >= 2;
				} else { this.errorCounts.clear(); this.gaveUpRetrying = false; }
				break;
			}
			case "tool": this.didWork = true; break;
			// A dialog holds the run open (a command waiting on it hasn't finished), until it is answered or declined.
			case "dialog":
				this.dialog = { title: String(e.title ?? e.kind ?? "a question"), since: Date.now() };
				if (!this.working) { this.working = true; this.dialogHeld = true; }
				this.changed();
				break;
			case "dialog_end": this.dialog = undefined; this.releaseDialog(); this.changed(); break;
			case "keys": this.lastKeys = Date.now(); break;
			case "owner": this.lastKeys = Date.now(); this.didWork = true; this.changed(); break;
			case "exit": this.closedNormally = true; break;
			case "exited": this.markExited(); break;
		}
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
		if (this.runner.commands) { try { sendCommand(this.channel!, { c: "decline" }); } catch { /* gone */ } return; }
		// Nothing can answer it for this agent: the run ends here, and says what it needed.
		this.livenessError = `nobody answered its dialog (${d.title.slice(0, 80)}) within ${Math.round((this.runner.dialogMs ?? DEFAULT_DIALOG_MS) / 60_000)}m; stopped`;
		void this.stop();
	}

	protected override markExited() {
		if (this.exited) return;
		this.stopTimer();
		for (const e of this.tail?.read() ?? []) if (e?.e !== "exited") this.event(e);
		this.endedWorking = this.working || (this.promptDispatched && !this.promptAccepted);
		super.markExited();
		this.wake(this.startWaiters, {}); this.wake(this.acceptWaiters, {});
	}

	/** Someone typed into it in its terminal within `ms`: it is theirs as much as the loop's, so it isn't closed under them. */
	ownerActiveWithin(ms: number): boolean { return Date.now() - this.lastKeys < ms; }
	/** Its process is still there (a run left by an earlier session of the loop). */
	get alive(): boolean { return !this.exited && (!this.pid || pidAlive(this.pid)); }

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

	/** Hand it the loop's prompt (or, for a runner that took it on its command line, see that it took it). */
	override async prompt(text: string): Promise<void> {
		if (this.runner.prompt === "channel") {
			const file = path.join(this.channel!, `prompt-${Date.now()}.txt`);
			fs.writeFileSync(file, text, { mode: 0o600 });
			// `report`: where loop_report writes for this fire (a thread's session takes several fires).
			sendCommand(this.channel!, { c: "prompt", file, report: this.topts.env.PI_LOOP_REPORT ?? "" });
			this.promptDispatched = true;
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
				// Refused before it was sent on (its companion checked first): nothing ran.
				this.promptDispatched = false;
				throw new Error(String(refused.why ?? "it refused the prompt"));
			}
			if (this.exited) { this.promptUncertain = true; throw new Error(`its ${this.runner.name} exited before it took the prompt`); }
			if (!got && (this.lastEventAt === seen || Date.now() > cap)) { this.promptUncertain = true; throw new Error(`no sign that its ${this.runner.name} took the prompt`); }
		}
	}

	override async steer(text: string): Promise<string | undefined> {
		this.didWork = true;
		if (this.runner.commands && this.channel) {
			try { sendCommand(this.channel, { c: "say", text }); } catch (e) { return (e as Error).message; }
			if (!this.working) { this.working = true; this.changed(); }
			this.push([`› (you) ${text.slice(0, 200)}`]);
			return undefined;
		}
		if (this.term?.send) return this.term.send(text);
		return `it runs in a terminal${this.term ? ` (${this.term.id})` : ""}; type there`;
	}

	override async lastText(): Promise<string | undefined> {
		return (this.sessionFile ? lastAssistantText(this.sessionFile) : undefined) ?? this.lastText_;
	}

	override async abort(): Promise<void> {
		if (this.runner.commands && this.channel) { try { sendCommand(this.channel, { c: "abort" }); } catch { /* gone */ } }
	}

	/** Ask it to quit, then end its process group, then have the provider close what is left. */
	override stop(graceMs = 5_000): Promise<void> {
		if (this.exited) return Promise.resolve();
		// Never started in a terminal: nothing to end.
		if (!this.pid && !this.term) { this.markExited(); return Promise.resolve(); }
		return new Promise(resolve => {
			this.exitWaiters.push(resolve);
			if (this.runner.commands && this.channel) { try { sendCommand(this.channel, { c: "exit" }); } catch { /* gone */ } }
			const term = () => {
				if (this.exited) return;
				if (this.pid) { try { process.kill(-this.pid, "SIGTERM"); } catch { try { process.kill(this.pid, "SIGTERM"); } catch { /* gone */ } } }
				else void this.term?.close?.().catch(() => undefined);
			};
			const kill = () => {
				if (this.exited) return;
				if (this.pid) { try { process.kill(-this.pid, "SIGKILL"); } catch { try { process.kill(this.pid, "SIGKILL"); } catch { /* gone */ } } }
				void this.term?.close?.().catch(() => undefined);
				setTimeout(() => this.markExited(), 1_000).unref?.();
			};
			const a = setTimeout(term, this.runner.commands ? Math.max(1_000, graceMs / 2) : 0), b = setTimeout(kill, graceMs);
			a.unref?.(); b.unref?.();
		});
	}
}
