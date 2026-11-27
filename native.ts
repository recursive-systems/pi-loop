/**
 * Native runs: a background loop's run as the agent's own interactive program (Claude Code or Codex) instead of a
 * hidden child Pi, so the owner can open it as an ordinary session. A loop opts in per model: its `agents` name
 * native agents, and a `model` entry whose provider is one of those names runs natively.
 *
 *   "agents": { "claude-dev1": { "run": "claude", "env": { "CLAUDE_CONFIG_DIR": "~/.claude-dev1" } },
 *               "codex": { "run": "codex" } },
 *   "model": ["claude-dev1/claude-sonnet-5-5", "codex/gpt-6.2-sol:high", "ai-gateway/claude-haiku-5-5"]
 *
 * pi-loop never opens terminals: a native run needs a host (a terminal multiplexer's integration) that answers the
 * run's `loop:run` start event, whose `native` field carries the exact argv and folder to start, by calling
 * `native.host(handle)`. Without one the run does not start, and the fire moves on to the next model.
 *
 * What the run does reaches pi-loop through a private folder per attempt (`PI_LOOP_NATIVE_DIR`, 0700): the agent's
 * own hooks (Claude Code) or notify command (Codex) append facts to `events.jsonl` (bin/native-hook.sh), and Claude
 * Code's status line leaves its usage in `usage.json`. The report is the same file a Pi run writes; the agent writes
 * it with bin/loop-report.mjs. The agent signs in as itself: pi-loop passes `env` (e.g. CLAUDE_CONFIG_DIR) to the
 * official binary and nothing else, never reads a login folder, and removes API-key and gateway variables, so a run
 * can't be billed to an API key by accident.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Run, type RunMode } from "./background.ts";

export type AgentKind = "claude" | "codex";
/**
 * How a native run may act without asking (nobody is there to answer):
 *   auto    the default. Claude Code's auto mode (its classifier runs what it judges safe and blocks the rest);
 *           Codex's --approve-for-me (its workspace sandbox, escalations reviewed automatically: no network, no
 *           writes outside the folder)
 *   full    no checks, as a Pi run has today: Claude Code --permission-mode bypassPermissions, Codex
 *           -a never -s danger-full-access. Only when the loop's owner declares it.
 */
export type Permissions = "auto" | "full";
export interface AgentSpec { run: AgentKind; env?: Record<string, string>; permissions?: Permissions }
export type Agents = Record<string, AgentSpec>;

/** What a host gives a native run: its terminal, and how to see and reach the program in it. */
export interface NativeHost {
	/** The terminal's address, for people ("t7"). */
	id: string;
	/** The program's state as the terminal knows it; exited once it has ended. */
	status(): Promise<{ state?: string; kind?: string; msg?: string; turn?: number; exited?: boolean } | undefined>;
	/** The visible screen as text. */
	read(): Promise<string>;
	/** Press keys, by Herdr's names: "enter", "down", "esc". */
	keys(...keys: string[]): Promise<boolean>;
	/** Type a message into it, as a person would. */
	send(text: string): Promise<boolean>;
	/** End the program and its terminal. */
	close(): Promise<void>;
}

/** What a native run's start event carries (`loop:run` `native`). */
export interface NativeLaunch { agent: string; kind: AgentKind; argv: string[]; cwd: string; host(h: NativeHost | Promise<NativeHost | undefined>): void }

const KINDS: readonly AgentKind[] = ["claude", "codex"];
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Never set through a loop: a key that would bill an API account, or pi-loop's and the terminal's own. */
const REFUSED_ENV = /^(ANTHROPIC_|OPENAI_API_KEY$|OPENAI_BASE_URL$|PI_LOOP_|HC_)/;
/** Removed from a native run's environment unless its agent sets them (names, plus these patterns in this process's environment). */
const STRIP: Record<AgentKind, { names: string[]; match: RegExp }> = {
	claude: {
		names: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_CUSTOM_HEADERS",
			"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
		match: /^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CLAUDE_PID$|CLAUDE_EFFORT$)/,
	},
	codex: { names: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"], match: /^(OPENAI_API_KEY$|OPENAI_BASE_URL$|CODEX_API_KEY$|CODEX_THREAD_ID$|CODEX_SANDBOX)/ },
};
/** A Claude Code turn that ended on one of these did nothing for want of its account or model: the fire moves on. */
const CLAUDE_UNAVAILABLE = new Set(["rate_limit", "overloaded", "authentication_failed", "billing_error", "server_error", "invalid_api_key", "oauth_token_expired"]);
/**
 * First-run screens, by fixed markers on them, and the keys that take the default way past (trust the run's own
 * folder: yes). Claude Code: theme, security notes, folder trust, bypass-mode notice (its settings skip that one).
 * Codex: folder trust (no flag or config override skips it).
 */
const SCREENS: Record<AgentKind, { marker: string; keys: string[] }[]> = {
	claude: [
		{ marker: "Choose the text style", keys: ["enter"] },
		{ marker: "Press Enter to continue", keys: ["enter"] },
		{ marker: "Yes, I trust this folder", keys: ["down", "enter"] },
		{ marker: "Yes, I accept", keys: ["down", "enter"] },
	],
	codex: [{ marker: "1. Trust and continue", keys: ["enter"] }],
};
/** How long a native run may take to take its prompt (first-run screens included). */
const START_MS = 120_000;
/** A dialog nobody answers stops the run after this long (it said it needed you). */
const DIALOG_MS = 10 * 60_000;
/** A run that shows no sign of life for this long while it works is stopped. */
const STALL_MS = 2 * 60 * 60_000;
const POLL_MS = 500, STATUS_MS = 2_000;

declare const __filename: string | undefined;
function here(): string {
	let source: string | undefined;
	try { source = fileURLToPath(import.meta.url); } catch { source = typeof __filename === "string" ? __filename : undefined; }
	if (!source) throw new Error("Couldn't locate pi-loop's native-run helpers");
	return path.dirname(source);
}
const hookPath = () => path.join(here(), "bin", "native-hook.sh");
const reportPath = () => path.join(here(), "bin", "loop-report.mjs");
const nodePath = () => /(^|[/\\])node(\.exe)?$/.test(process.execPath) ? process.execPath : "node";
const q = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
const tilde = (v: string) => v === "~" ? os.homedir() : v.startsWith("~/") ? path.join(os.homedir(), v.slice(2)) : v;

/** A loop's declared `agents`. Throws with what is wrong. */
export function parseAgents(v: unknown): Agents | undefined {
	if (v === undefined) return undefined;
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("agents must be an object: {\"<name>\": {\"run\": \"claude\" | \"codex\", \"env\": {...}}}");
	const out: Agents = {};
	const entries = Object.entries(v as Record<string, any>);
	if (entries.length > 10) throw new Error("agents: at most 10");
	for (const [name, spec] of entries) {
		if (!NAME.test(name)) throw new Error(`agents: name "${name}" must be lowercase letters, digits, - and _`);
		if (!spec || typeof spec !== "object" || !KINDS.includes(spec.run)) throw new Error(`agents.${name}.run must be claude or codex`);
		for (const k of Object.keys(spec)) if (!["run", "env", "permissions"].includes(k)) throw new Error(`agents.${name}: unknown field ${k}`);
		const env: Record<string, string> = {};
		if (spec.env !== undefined) {
			if (!spec.env || typeof spec.env !== "object" || Array.isArray(spec.env)) throw new Error(`agents.${name}.env must be an object of strings`);
			for (const [k, val] of Object.entries(spec.env)) {
				if (!ENV_NAME.test(k) || typeof val !== "string") throw new Error(`agents.${name}.env.${k} must be a string`);
				if (REFUSED_ENV.test(k)) throw new Error(`agents.${name}.env can't set ${k}: a native run signs in as its agent's own login, never with an API key or pi-loop's own variables`);
				env[k] = val;
			}
		}
		if (spec.permissions !== undefined && spec.permissions !== "auto" && spec.permissions !== "full") throw new Error(`agents.${name}.permissions must be auto (the default) or full`);
		out[name] = { run: spec.run, ...(Object.keys(env).length ? { env } : {}), ...(spec.permissions === "full" ? { permissions: "full" as const } : {}) };
	}
	return Object.keys(out).length ? out : undefined;
}

/** The native agent a model choice names (its provider is one of the loop's agents), with the agent's own model id. */
export function agentFor(choice: string | undefined, agents: Agents | undefined): { name: string; spec: AgentSpec } | undefined {
	if (!choice || !agents) return undefined;
	const slash = choice.indexOf("/");
	const name = slash > 0 ? choice.slice(0, slash) : "";
	return Object.hasOwn(agents, name) ? { name, spec: agents[name]! } : undefined;
}

/** Pi's context files for a folder that Claude Code doesn't read itself: AGENTS.md from the folder up, and the agent dir's. */
function contextText(cwd: string, agentDir: string): string {
	const files: string[] = [];
	const global = path.join(agentDir, "AGENTS.md");
	if (fs.existsSync(global)) files.push(global);
	const up: string[] = [];
	for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
		const f = path.join(d, "AGENTS.md");
		// Claude Code reads a folder's CLAUDE.md itself; where there is one, Pi reads that folder's AGENTS.md instead of it.
		if (fs.existsSync(f)) up.unshift(f);
		if (path.dirname(d) === d) break;
	}
	files.push(...up.filter(f => f !== global));
	return files.map(f => { try { return `Contents of ${f} (instructions for this folder):\n\n${fs.readFileSync(f, "utf8").trim()}`; } catch { return ""; } })
		.filter(Boolean).join("\n\n");
}

export interface NativeOptions {
	agent: string; spec: AgentSpec;
	/** The agent's own model id, and Pi's thinking level for it. */
	agentModel: string; thinking?: string;
	/** This attempt's private folder. */
	dir: string;
	/** The loop's prompt, as it is sent. */
	text: string;
	/** The agent's own session to carry on (a thread). */
	resume?: string;
	/** Pi's agent dir (its AGENTS.md is context too). */
	agentDir: string;
	/** For the terminal's status line: "loop <id> #<fire>". */
	label: string;
}

/** One native run: the agent in a host's terminal, followed through its hooks. Shares Run's record, finish and fallback code. */
export class NativeRun extends Run {
	readonly native: NativeOptions;
	host?: NativeHost;
	private hostWait?: Promise<NativeHost | undefined>;
	/** The agent's own session id (Claude Code) or thread id (Codex). */
	agentSession?: string;
	private lastMessage?: string;
	/** The agent said it couldn't serve: why ("rate_limit"). */
	agentError?: string;
	private offset = 0;
	private poll?: ReturnType<typeof setInterval>;
	private polling = false;
	private lastStatusAt = 0;
	private lastLife = Date.now();
	private blockedSince?: number;
	private status?: { state?: string; kind?: string; msg?: string; turn?: number };
	private accepted = false;
	private resent = false;
	private readyAt?: number;
	private screensAnswered = 0;
	/** Its turn ended (Claude Code's Stop / StopFailure, Codex's turn notice). */
	private settled = false;
	usage?: Record<string, unknown>;

	constructor(loopId: string, fire: number, mode: RunMode, opts: ConstructorParameters<typeof Run>[3], native: NativeOptions) {
		super(loopId, fire, mode, opts);
		this.native = native;
		fs.mkdirSync(native.dir, { recursive: true, mode: 0o700 });
		try { fs.chmodSync(native.dir, 0o700); } catch { /* best effort */ }
		this.agentSession = native.spec.run === "claude" ? native.resume ?? this.attemptId : native.resume;
	}

	get kind(): AgentKind { return this.native.spec.run; }

	/** The exact program the host starts (`env` first: what is removed, what is set), in the run's folder. */
	argv(): string[] {
		const n = this.native, kind = n.spec.run, env = this.opts.env;
		const own: Record<string, string> = { PI_LOOP_CHILD: "1", PI_LOOP_ID: this.loopId, PI_LOOP_REPORT: String(env.PI_LOOP_REPORT ?? ""),
			PI_LOOP_NATIVE_DIR: n.dir, PI_LOOP_NATIVE_LABEL: n.label };
		const set: Record<string, string> = { ...Object.fromEntries(Object.entries(n.spec.env ?? {}).map(([k, v]) => [k, tilde(v)])), ...own };
		const strip = new Set([...STRIP[kind].names, ...Object.keys(process.env).filter(k => STRIP[kind].match.test(k))]);
		for (const k of Object.keys(set)) strip.delete(k);
		const prompt = n.text + this.reportNote();
		const effort = n.thinking && n.thinking !== "off" ? (n.thinking === "minimal" ? "low" : n.thinking) : undefined;
		const full = n.spec.permissions === "full";
		let agent: string[];
		if (kind === "claude") {
			const settings = path.join(n.dir, "settings.json");
			fs.writeFileSync(settings, JSON.stringify(claudeSettings()), { mode: 0o600 });
			const context = contextText(this.cwd, n.agentDir);
			agent = ["claude", "--model", n.agentModel, ...(effort ? ["--effort", effort === "max" ? "max" : effort] : []),
				"--permission-mode", full ? "bypassPermissions" : "auto", "--settings", settings, ...(context ? ["--append-system-prompt", context] : []),
				...(n.resume ? ["--resume", n.resume] : ["--session-id", this.attemptId]), "-n", n.label, prompt];
		} else {
			const hook = JSON.stringify([hookPath(), "notify"]);
			agent = ["codex", "--no-daemon", "-m", n.agentModel, ...(effort ? ["-c", `model_reasoning_effort="${effort === "max" ? "xhigh" : effort}"`] : []),
				...(full ? ["-a", "never", "-s", "danger-full-access"] : ["--approve-for-me"]), "-c", `notify=${hook}`, ...(n.resume ? ["resume", n.resume] : []), prompt];
		}
		return ["env", ...[...strip].sort().flatMap(k => ["-u", k]), ...Object.entries(set).map(([k, v]) => `${k}=${v}`), ...agent];
	}

	/** How it reports, since it has no loop_report tool. */
	private reportNote(): string {
		const cmd = `${q(nodePath())} ${q(reportPath())}`;
		return `\n\n[pi-loop] You are running natively (${this.kind === "claude" ? "Claude Code" : "Codex"}), not in Pi, so there is no loop_report tool. ` +
			`Wherever these instructions say loop_report, run this shell command once instead, at the end: ` +
			`${cmd} --findings false --summary "<one line>" (findings true when the owner should see something; add --ask "<the one thing>", --next 2m or --stop only as loop_report describes).`;
	}

	/** Its host, from the start event (bounded: the event waits a few seconds at most for its listeners). */
	provide(h: NativeHost | Promise<NativeHost | undefined>) {
		this.hostWait = Promise.resolve(h).then(x => { if (x) this.host = x; return x; }, () => undefined);
	}

	async start(): Promise<void> {
		this.proc = undefined;
		const host = await this.hostWait;
		if (!host) throw new Error(`a native ${this.kind} run needs a terminal host (pi-loop-herdr with Herdr), and nothing here supplied one`);
		this.poll = setInterval(() => { void this.tick(); }, POLL_MS);
		this.poll.unref?.();
	}

	/** Codex says whether it is signed in; Claude Code has no such command (a run that can't sign in never takes its prompt). */
	async listsCredentials(): Promise<boolean> {
		if (this.kind !== "codex") return true;
		const env = { ...process.env, ...Object.fromEntries(Object.entries(this.native.spec.env ?? {}).map(([k, v]) => [k, tilde(v)])) };
		for (const k of Object.keys(env)) if (STRIP.codex.match.test(k) && !this.native.spec.env?.[k]) delete env[k];
		return new Promise(resolve => execFile("codex", ["login", "status"], { env, timeout: 15_000 }, (err, out, errOut) => resolve(!err && /logged in/i.test(`${out}${errOut}`))));
	}

	/** Its prompt went in with its program: wait until the agent has taken it (getting it past first-run screens). */
	async prompt(text: string): Promise<void> {
		if (text !== this.native.text) throw new Error("a native run takes only its own prompt");
		this.working = true;
		const end = Date.now() + START_MS;
		while (!this.accepted && !this.exited && Date.now() < end) {
			await new Promise(r => setTimeout(r, 250));
			if (this.settled && !this.accepted) break;
		}
		if (!this.accepted) {
			this.working = false;
			// The agent never took it (its own prompt hook never ran): nothing was done, so this fire may move on.
			await this.close();
			throw new Error(this.exited ? `${this.kind} exited before it took the prompt` : `${this.kind} didn't take the prompt within ${START_MS / 1000}s${this.status?.state === "blocked" ? ` (it waits on: ${this.status.msg ?? "a dialog"})` : ""}`);
		}
		this.promptDispatched = true;
		this.promptAccepted = true;
		this.disposition = "started";
		this.push([`› ${text.split("\n")[0]!.slice(0, 200)}`]);
	}

	private async tick() {
		if (this.polling || this.exited) return;
		this.polling = true;
		try {
			this.readEvents();
			if (Date.now() - this.lastStatusAt >= STATUS_MS && this.host) { this.lastStatusAt = Date.now(); await this.checkHost(); }
		} catch { /* the next tick tries again */ }
		finally { this.polling = false; }
	}

	private readEvents() {
		const file = path.join(this.native.dir, "events.jsonl");
		let buf: Buffer;
		try { buf = fs.readFileSync(file); } catch { return; }
		if (buf.length <= this.offset) return;
		const end = buf.lastIndexOf(10);
		if (end < this.offset) return;
		const chunk = buf.subarray(this.offset, end + 1).toString("utf8");
		this.offset = end + 1;
		for (const line of chunk.split("\n")) {
			if (!line.trim()) continue;
			let ev: any;
			try { ev = JSON.parse(line); } catch { continue; }
			this.onEvent(String(ev?.e ?? ""), ev?.in ?? {});
		}
	}

	private onEvent(e: string, input: any) {
		this.lastLife = Date.now();
		if (this.kind === "claude") {
			if (input?.session_id && typeof input.session_id === "string") this.agentSession = input.session_id;
			if (e === "UserPromptSubmit") { if (!this.accepted) { this.accepted = true; this.starts++; } else this.didWork = true; this.working = true; this.settled = false; this.changed(); }
			else if (e === "PreToolUse" || e === "PostToolUse") { this.didWork = true; if (input?.tool_name) this.push([`  ⚙ ${String(input.tool_name)}`]); }
			else if (e === "Stop") {
				const t = typeof input?.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
				if (t) { this.lastMessage = t; this.didWork = true; this.push([t]); }
				this.modelFailure = undefined; this.agentError = undefined; this.lastError = undefined;
				this.end();
			} else if (e === "StopFailure") {
				const why = String(input?.error ?? "error");
				this.agentError = why; this.modelFailure = "model_error";
				const said: string = typeof input?.last_assistant_message === "string" ? input.last_assistant_message : why;
				this.lastError = said;
				this.gaveUpRetrying = CLAUDE_UNAVAILABLE.has(why);
				this.push([`  ! ${said.slice(0, 200)}`]);
				this.end();
			} else if (e === "SessionEnd") { /* the host sees the exit */ }
			return;
		}
		// Codex: its notify command, after each turn. The run's thread is the one whose input is the run's prompt (by its
		// `[loop …]` first line); other threads are Codex's own side work (it titles each session in a thread of its own).
		if (e === "notify" && input?.type === "agent-turn-complete") {
			const id = typeof input["thread-id"] === "string" ? input["thread-id"] : undefined;
			if (!this.agentSession) {
				const head = this.native.text.split("\n")[0]!.trim();
				const inputs: unknown[] = Array.isArray(input["input-messages"]) ? input["input-messages"] : [];
				if (!id || !inputs.some(m => typeof m === "string" && m.trimStart().startsWith(head))) return;
				this.agentSession = id;
			}
			if (id !== this.agentSession) return;
			if (!this.accepted) { this.accepted = true; this.starts++; }
			const t = typeof input["last-assistant-message"] === "string" ? input["last-assistant-message"].trim() : "";
			if (t) { this.lastMessage = t; this.push([t]); }
			this.didWork = true; this.modelFailure = undefined;
			this.end();
		}
	}

	/** Its turn ended: idle until it starts another. */
	private end() {
		this.settled = true;
		if (this.working) this.settle();
	}

	private async checkHost() {
		let s: Awaited<ReturnType<NativeHost["status"]>>;
		try { s = await this.host!.status(); } catch { return; }
		if (!s) return;
		if (s.exited) { this.gone(); return; }
		const before = JSON.stringify(this.status);
		this.status = s;
		if (JSON.stringify(s) !== before) this.lastLife = Date.now();
		const now = Date.now();
		if (s.state === "blocked") this.blockedSince ??= now; else this.blockedSince = undefined;
		if (!this.accepted) {
			// Codex has no prompt hook: its first turn (working, or a turn already counted) is its prompt taken.
			if (this.kind === "codex" && (s.state === "working" || (s.turn ?? 0) > 0)) { this.accepted = true; this.starts++; return; }
			// First-run screens (a login folder opened for the first time, a folder it doesn't trust yet): the default way past.
			if (this.screensAnswered < 8) {
				const screen = await this.host!.read().catch(() => "");
				const shown = SCREENS[this.kind].find(x => screen.includes(x.marker));
				if (shown) { this.screensAnswered++; this.readyAt = undefined; await this.host!.keys(...shown.keys).catch(() => false); return; }
			}
			// Ready, yet its prompt hook never ran: the prompt was dropped on the way in (a first-run screen took it). Type it once.
			if (this.kind === "claude" && (s.state === "idle" || s.state === "done")) {
				this.readyAt ??= now;
				if (!this.resent && now - this.readyAt > 8_000) { this.resent = true; await this.host!.send(this.native.text + this.reportNote()).catch(() => false); }
			} else this.readyAt = undefined;
			return;
		}
		if (this.kind === "codex" && s.state === "error" && this.working) {
			// Codex shows a model or account error as its status, and has no notice for it.
			this.modelFailure = "model_error"; this.lastError = s.msg ?? "error"; this.agentError = s.msg ?? "error";
			this.end();
			return;
		}
		if (this.blockedSince && now - this.blockedSince > DIALOG_MS && this.working) {
			this.needsYou = `${this.kind}: ${String(s.msg ?? "waiting on a dialog").slice(0, 120)}`;
			this.extensionFailed = true;
			await this.close();
			return;
		}
		if (this.working && now - this.lastLife > STALL_MS) { this.lastError = "no sign of life for 2h"; this.extensionFailed = true; await this.close(); }
	}

	/** The program ended. */
	private gone() {
		if (this.exited) return;
		this.exited = true; this.working = false;
		if (this.poll) clearInterval(this.poll);
		for (const w of this.exitWaiters.splice(0)) w();
		for (const w of this.idleWaiters.splice(0)) w();
		this.changed();
	}

	/** End its program (a failed, cancelled or thread run; or one that never took its prompt). */
	private async close() {
		if (this.poll) clearInterval(this.poll);
		try { await this.host?.close(); } catch { /* gone */ }
		this.gone();
	}

	get failedBeforeWork(): boolean { return this.modelFailure === "model_error" && !this.extensionFailed && !this.didWork && this.accepted; }

	async lastText(): Promise<string | undefined> { return this.lastMessage; }
	/** The last thing it said, without asking it (it may have ended). */
	get lastKnownText(): string | undefined { return this.lastMessage; }

	async steer(text: string): Promise<string | undefined> {
		if (!this.host || this.exited) return "its terminal has ended";
		this.didWork = true;
		return (await this.host.send(text).catch(() => false)) ? undefined : "not delivered";
	}

	async abort(): Promise<void> { await this.host?.keys("esc").catch(() => false); }

	/**
	 * Once its run is recorded: a fresh run that finished well stays open in its terminal for the owner (its host
	 * sweeps old ones); anything else ends (a thread is carried on by the next fire, never by two programs at once).
	 */
	async stop(): Promise<void> {
		this.readUsage();
		if (this.exited) return;
		const keep = this.accepted && this.settled && !this.working && !this.cancelled && !this.modelFailure && !this.extensionFailed && this.mode !== "thread";
		if (keep) { if (this.poll) clearInterval(this.poll); return; }
		await this.close();
	}

	/** Its usage as its status line last showed it (Claude Code), for the run's record. */
	readUsage(): Record<string, unknown> | undefined {
		try {
			const u = JSON.parse(fs.readFileSync(path.join(this.native.dir, "usage.json"), "utf8"));
			this.usage = {
				...(u?.model?.id ? { model: u.model.id } : {}),
				...(Number.isFinite(u?.cost?.total_cost_usd) ? { costUsd: u.cost.total_cost_usd } : {}),
				...(Number.isFinite(u?.cost?.total_duration_ms) ? { durationMs: u.cost.total_duration_ms } : {}),
				...(Number.isFinite(u?.cost?.total_api_duration_ms) ? { apiMs: u.cost.total_api_duration_ms } : {}),
				...(Number.isFinite(u?.context_window?.total_input_tokens) ? { input: u.context_window.total_input_tokens } : {}),
				...(Number.isFinite(u?.context_window?.total_output_tokens) ? { output: u.context_window.total_output_tokens } : {}),
				...(u?.rate_limits && typeof u.rate_limits === "object" ? { rateLimits: u.rate_limits } : {}),
			};
		} catch { /* none (Codex has no status line): unknown, not zero */ }
		return this.usage;
	}

	/** For the run's record: which agent, its terminal, its own session. */
	info(): { agent: string; run: AgentKind; terminal?: string; session?: string; error?: string } {
		return { agent: this.native.agent, run: this.kind, ...(this.host ? { terminal: this.host.id } : {}), ...(this.agentSession ? { session: this.agentSession } : {}), ...(this.agentError ? { error: this.agentError } : {}) };
	}
}

/** Claude Code's settings for a run: its hooks and status line report here; a run declared `full` doesn't stop on the bypass-mode notice. */
function claudeSettings(): object {
	const hook = q(hookPath());
	const on = (event: string) => [{ hooks: [{ type: "command", command: `${hook} event ${event}` }] }];
	return {
		skipDangerousModePermissionPrompt: true,
		statusLine: { type: "command", command: `${hook} status` },
		hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "StopFailure", "SessionEnd"].map(e => [e, on(e)])),
	};
}
