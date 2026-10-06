/**
 * Background loop runs: a child Pi in RPC mode that this session drives, so a loop's work happens
 * beside the conversation instead of in it. The child is started on one of three sessions:
 *
 *   fork    a copy of this session as it is now (Pi --fork), saved apart from it
 *   thread  the loop's own conversation, continued every run (--continue in the loop's folder)
 *   fresh   a new conversation each run
 *
 * The child runs in the same working directory with the same model and environment, plus
 * PI_LOOP_CHILD=1 (pi-loop schedules nothing there; it offers loop_report instead) and
 * PI_LOOP_REPORT (where loop_report writes). It never shares a session file with another writer:
 * the session is handed over only after the child has exited.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVENESS_STATUS_KEY } from "./liveness.ts";

declare const __filename: string | undefined;
function livenessExtension(): string {
	let source: string | undefined;
	try { source = fileURLToPath(import.meta.url); } catch { source = typeof __filename === "string" ? __filename : undefined; }
	if (!source) throw new Error("Couldn't locate the background-work liveness companion");
	return path.join(path.dirname(source), "liveness.ts");
}

export type RunMode = "fork" | "thread" | "fresh";
export const RUN_MODES: readonly RunMode[] = ["fork", "thread", "fresh"];

export type RunStatus = "starting" | "running" | "done" | "failed" | "cancelled" | "interrupted" | "away";

/** What a loop's run reports through loop_report (or what is assumed when it doesn't). */
export interface Report { findings: boolean; summary?: string; next?: string; stop?: boolean }

/** A run as remembered in .pi/loops.json (the live process is not). */
export interface RunRecord {
	fire: number;
	mode: RunMode;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	session?: string;
	/** The Pi process that ran it; a record still "running" under another (dead) pid was interrupted. */
	host?: number;
	result?: string;
	findings?: boolean;
	/** Something it couldn't do without you (a dialog it was asked to answer). */
	needsYou?: string;
	/** Shown in the inbox until you look at it. */
	unread?: boolean;
}

/** Pi's folder name for a cwd's sessions, with a suffix: --home-u-project-loop-check-- */
export function sessionFolder(root: string, cwd: string, suffix: string): string {
	const enc = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	return path.join(root, `--${enc}${suffix}--`);
}

/** The Pi that runs this extension, to start its children the same way. */
export function piCommand(): { cmd: string; args: string[] } {
	const script = process.argv[1];
	const inherited = extensionFlags(process.argv.slice(2));
	if (script && fs.existsSync(script) && /\.(c|m)?js$|[/\\]pi$/.test(script)) return { cmd: process.execPath, args: [script, ...inherited] };
	return { cmd: "pi", args: inherited };
}

/** The session's own extension and trust flags (-e, -ne, -a, -na, --offline, --api-key), so a run loads what it loads. */
export function extensionFlags(argv: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const where = (v: string) => (/^[a-z]+:/.test(v) ? v : path.resolve(v)); // builtin:, npm:, git: stay as they are
		if ((a === "-e" || a === "--extension") && argv[i + 1]) out.push(a, where(argv[++i]));
		else if (a.startsWith("--extension=")) out.push("--extension", where(a.slice(12)));
		else if (["-ne", "--no-extensions", "-a", "--approve", "-na", "--no-approve", "--offline"].includes(a)) out.push(a);
		else if (a === "--api-key" && argv[i + 1]) out.push(a, argv[++i]);
	}
	return out;
}

/** The last assistant text in a session file (for a run taken over and finished by you). */
export function lastAssistantText(file: string): string | undefined {
	let text: string | undefined;
	try {
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (!line.includes('"assistant"')) continue;
			try {
				const e = JSON.parse(line);
				const m = e.message;
				if (e.type !== "message" || m?.role !== "assistant") continue;
				const t = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
				if (t) text = t;
			} catch { /* not an entry */ }
		}
	} catch { /* gone */ }
	return text;
}

/** Recent lines of a session file as readable transcript lines (for watching a finished run). */
export function transcriptOf(file: string, max = 200): string[] {
	const out: string[] = [];
	try {
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try { out.push(...entryLines(JSON.parse(line))); } catch { /* not an entry */ }
		}
	} catch { /* gone */ }
	return out.slice(-max);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("");
}

function entryLines(e: any): string[] {
	if (e?.type !== "message") return [];
	return messageLines(e.message);
}

function messageLines(m: any): string[] {
	if (!m) return [];
	if (m.role === "user") return [`› ${textOf(m.content).trim()}`];
	if (m.role === "assistant") {
		const out: string[] = [];
		for (const c of m.content ?? []) {
			if (c?.type === "text" && c.text.trim()) out.push(c.text.trim());
			if (c?.type === "toolCall") out.push(`  ⚙ ${c.name} ${JSON.stringify(c.arguments ?? {}).slice(0, 160)}`);
		}
		return out;
	}
	if (m.role === "toolResult") return [`  ↳ ${textOf(m.content).trim().split("\n")[0]?.slice(0, 160) ?? ""}`];
	return [];
}

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/** One live background run. */
export class Run {
	proc?: ChildProcessWithoutNullStreams;
	sessionFile?: string;
	lines: string[] = [];
	working = false;
	/** Detached work or its queued completion still needs this exact session alive. */
	backgroundWork = false;
	livenessError?: string;
	private livenessReady = false;
	exited = false;
	needsYou?: string;
	/** Set when the run is being handed to you, so its exit is not a failure. */
	handedOver = false;
	/** Set while its result is being collected; your words then wait and start it again. */
	finishing = false;
	/** Its outcome has been recorded (once, by whichever instance is live). */
	recorded = false;
	/** Turns started so far: a command's own turn may begin before or after Pi answers "handled". */
	private starts = 0;
	cancelled = false;
	private buf = "";
	private seq = 0;
	private waiting = new Map<string, (r: any) => void>();
	private changes = new Set<() => void>();
	private exitWaiters: (() => void)[] = [];
	private idleWaiters: (() => void)[] = [];

	constructor(
		readonly loopId: string,
		readonly fire: number,
		readonly mode: RunMode,
		private readonly opts: { cwd: string; sessionArgs: string[]; extra?: string[]; model?: string; thinking?: string; env: NodeJS.ProcessEnv },
	) {}

	onChange(fn: () => void) { this.changes.add(fn); return () => this.changes.delete(fn); }
	private changed() { for (const fn of this.changes) { try { fn(); } catch { /* a viewer's problem */ } } }
	private push(lines: string[]) {
		for (const l of lines) if (l) this.lines.push(l);
		if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
		this.changed();
	}

	/** Start the child and learn its session file. */
	async start(): Promise<void> {
		const { cmd, args } = piCommand();
		const model = this.opts.model ? ["--model", this.opts.model, ...(this.opts.thinking ? ["--thinking", this.opts.thinking] : [])] : [];
		const proc = spawn(cmd, [...args, ...(this.opts.extra ?? []), "-e", livenessExtension(), "--mode", "rpc", ...this.opts.sessionArgs, ...model], { cwd: this.opts.cwd, env: this.opts.env });
		this.proc = proc;
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (d: string) => {
			this.buf += d;
			let i;
			while ((i = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, i).replace(/\r$/, "");
				this.buf = this.buf.slice(i + 1);
				let msg: any;
				try { msg = JSON.parse(line); } catch { continue; }
				this.handle(msg);
			}
		});
		proc.stderr.on("data", () => { /* Pi's own diagnostics; not part of the run */ });
		proc.on("exit", () => {
			this.exited = true; this.working = false;
			for (const w of this.waiting.values()) w({ success: false, error: "the run's Pi exited" });
			this.waiting.clear();
			for (const w of this.exitWaiters.splice(0)) w();
			for (const w of this.idleWaiters.splice(0)) w();
			this.changed();
		});
		proc.on("error", () => { /* exit follows */ });
		const state = await this.send({ type: "get_state" }, 60_000);
		if (!state?.success) throw new Error(state?.error ?? "the run's Pi did not start");
		this.sessionFile = state.data?.sessionFile;
		if (!this.livenessReady) throw new Error("The run did not load its background-work liveness companion");
		if (this.livenessError) throw new Error(this.livenessError);
	}

	private handle(msg: any) {
		if (msg.type === "response" && msg.id && this.waiting.has(msg.id)) {
			const w = this.waiting.get(msg.id)!;
			this.waiting.delete(msg.id);
			w(msg);
			return;
		}
		if (msg.type === "extension_ui_request" && msg.method === "setStatus" && msg.statusKey === LIVENESS_STATUS_KEY) {
			this.livenessReady = true;
			this.backgroundWork = msg.statusText === "busy";
			if (msg.statusText !== "busy" && msg.statusText !== "idle") this.livenessError = "Couldn't establish whether the run still owns background work";
			this.changed();
			return;
		}
		if (msg.type === "extension_ui_request" && DIALOGS.has(msg.method)) {
			// Nobody is there to answer a dialog in a background run: decline it, and say so.
			this.needsYou = `${msg.method}: ${String(msg.title ?? msg.message ?? "").slice(0, 120)}`;
			this.write({ type: "extension_ui_response", id: msg.id, cancelled: true });
			this.push([`  ! declined a ${msg.method} (needs you): ${String(msg.title ?? "").slice(0, 100)}`]);
			return;
		}
		if (msg.type === "agent_start") { this.starts++; this.working = true; this.changed(); return; }
		if (msg.type === "agent_settled") { this.settle(); return; }
		if (msg.type === "message_end" && msg.message) this.push(messageLines(msg.message));
	}

	private write(cmd: object) {
		if (this.exited || !this.proc) return;
		try { this.proc.stdin.write(JSON.stringify(cmd) + "\n"); } catch { /* exiting */ }
	}

	send(cmd: object, ms = 30_000): Promise<any> {
		if (this.exited) return Promise.resolve({ success: false, error: "the run's Pi exited" });
		const id = `l${++this.seq}`;
		return new Promise(resolve => {
			const t = setTimeout(() => { this.waiting.delete(id); resolve({ success: false, error: "no answer from the run's Pi" }); }, ms);
			this.waiting.set(id, r => { clearTimeout(t); resolve(r); });
			this.write({ id, ...cmd });
		});
	}

	/** Start the loop's work; resolves once Pi accepted it. */
	async prompt(text: string): Promise<void> {
		this.working = true;
		const before = this.starts;
		const r = await this.send({ type: "prompt", message: text });
		if (!r?.success) { this.working = false; throw new Error(r?.error ?? "the run's Pi refused the prompt"); }
		this.push([`› ${text.split("\n")[0].slice(0, 200)}`]);
		// An extension command is handled without a turn: there will be no agent_settled, unless the command
		// started one itself (before or shortly after its answer).
		if (r.data?.disposition === "handled") this.settleUnlessStarted(before);
	}

	/** Settle a handled command unless it started a turn of its own, now or within a few seconds. */
	private settleUnlessStarted(before: number) {
		if (this.starts > before) return;
		const t = setTimeout(() => { if (this.starts === before && this.working) this.settle(); }, 3_000);
		t.unref?.();
	}

	private settle() {
		this.working = false;
		for (const w of this.idleWaiters.splice(0)) w();
		this.changed();
	}

	/** Your words to the run: steered into the work if it is running, otherwise a new turn. */
	async steer(text: string): Promise<string | undefined> {
		const steering = this.working;
		const before = this.starts;
		if (!steering) this.working = true;
		// While it is working (or a handled command may still start a turn), a prompt that steers: steered into a
		// running turn, or a turn of its own if none is running (a bare steer would wait in the queue for a turn
		// that never comes, and your words would be lost when the run is stopped).
		const r = await this.send(steering ? { type: "prompt", message: text, streamingBehavior: "steer" } : { type: "prompt", message: text });
		if (!r?.success) { if (!steering) this.settle(); return r?.error ?? "not delivered"; }
		this.push([`› (you) ${text.slice(0, 200)}`]);
		if (!steering && r.data?.disposition === "handled") this.settleUnlessStarted(before);
		return undefined;
	}

	/** Resolves when the run is idle (or gone); false after `ms`. */
	waitIdle(ms: number): Promise<boolean> {
		if (!this.working || this.exited) return Promise.resolve(true);
		return new Promise(resolve => {
			const t = setTimeout(() => { this.idleWaiters = this.idleWaiters.filter(w => w !== done); resolve(false); }, ms);
			const done = () => { clearTimeout(t); resolve(true); };
			this.idleWaiters.push(done);
		});
	}

	async lastText(): Promise<string | undefined> {
		const r = await this.send({ type: "get_last_assistant_text" });
		return r?.success ? (r.data?.text ?? undefined) : (this.sessionFile ? lastAssistantText(this.sessionFile) : undefined);
	}

	async abort(): Promise<void> { await this.send({ type: "abort" }, 10_000); }

	/** End the child and wait for it to exit (SIGTERM, then SIGKILL). */
	stop(graceMs = 5_000): Promise<void> {
		if (this.exited || !this.proc) return Promise.resolve();
		return new Promise(resolve => {
			this.exitWaiters.push(resolve);
			try { this.proc!.stdin.end(); } catch { /* closed */ }
			const term = setTimeout(() => { if (!this.exited) this.proc!.kill("SIGTERM"); }, 1_000);
			const kill = setTimeout(() => { if (!this.exited) this.proc!.kill("SIGKILL"); }, graceMs);
			term.unref?.(); kill.unref?.();
		});
	}
}
