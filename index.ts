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
 * When a loop is due, its prompt is sent to this session as a user message
 * (`sendUserMessage`, deliverAs "followUp"): idle -> a turn starts now; busy ->
 * it runs after the current turn. The turn shares this session's context, which
 * is the point of this design over a scheduled child. Loops persist in
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
function configuredZone(cwd: string): { tz: string; source: string; warning?: string } {
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

function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
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
	let gateLog = "";

	const zoneOf = (l: Loop) => l.tz ?? zone.tz;
	const nextFor = (l: Loop, from: number) => nextAtFor(l.schedule, from, l.createdAt, zoneOf(l));
	const when = (l: Loop) => fmtTime(l.nextAt, zoneOf(l));
	/** Loops whose fire times depend on a zone: daily `at` and whole-day intervals (1d, 7d). */
	const zoned = (sch: Schedule) => sch.kind === "at" || sch.ms % 86_400_000 === 0;
	const desc = (l: Loop) => describe(l.schedule, zoned(l.schedule) ? zoneOf(l) : undefined);

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
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(loops, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, file);
	}
	function claimLock(): boolean {
		try {
			const pid = Number(fs.readFileSync(lock, "utf8").trim());
			if (pid && pid !== process.pid && pidAlive(pid)) return false;
		} catch { /* no lock */ }
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		fs.writeFileSync(lock, String(process.pid), { mode: 0o600 });
		return true;
	}
	function releaseLock() {
		try { if (fs.readFileSync(lock, "utf8").trim() === String(process.pid)) fs.unlinkSync(lock); } catch { /* fine */ }
	}
	function ownerPid(): string {
		try { return fs.readFileSync(lock, "utf8").trim(); } catch { return "?"; }
	}

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
		if (phase) { ctx.ui.setStatus(STATUS_KEY, `loops: ${active.length} \u00b7 ${phase.id} ${phase.state}`); return; }
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
			return `${l.id}  ${desc(l)}  ${state}  ×${l.fires}\n    ${p}${l.gate ? `\n    ${gateText(l)}` : ""}`;
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

	function add(schedule: Schedule, prompt: string, id?: string, tz?: string, gate?: GateConfig): Loop | string {
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
		if (gate) l.gate = gate; else delete l.gate;
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
		const d = await runGate(ctx!.cwd, l.gate, { id: l.id, prompt: l.prompt, lastWokeAt: l.lastWokeAt, stateDir: path.join(ctx!.cwd, ".pi", "loop-state", l.id), test: true, session });
		const extra = d.action === "defer" ? ` (retry in ${countdown(d.retryInMs ?? 0)})` : "";
		return `${l.id} gate (test, no wake) -> ${d.action}${extra} in ${Date.now() - t0}ms: ${d.reason}${d.context ? `\n${d.context}` : ""}`;
	}

	/** Run a gated loop's gate, then wake, skip or defer. The loop is rescheduled first so it is not due twice. */
	function gateThen(l: Loop, reason: "due" | "catch-up") {
		const started = Date.now();
		l.nextAt = nextFor(l, started);
		gating.add(l.id);
		save();
		void runGate(ctx!.cwd, l.gate!, { id: l.id, prompt: l.prompt, lastWokeAt: l.lastWokeAt, stateDir: path.join(ctx!.cwd, ".pi", "loop-state", l.id), session: sessionOf(ctx) })
			.then(raw => {
				gating.delete(l.id);
				if (!ctx || readOnly || !loops.includes(l)) return;
				const d = backoff(l, raw, Date.now());
				l.gateRuns = (l.gateRuns ?? 0) + 1;
				l.lastGate = { at: Date.now(), action: d.action, reason: d.reason };
				logDecision(gateLog, { ts: new Date().toISOString(), id: l.id, action: d.action, reason: d.reason, ms: Date.now() - started, ...(d.error ? { error: true } : {}) });
				if (d.action === "defer") l.nextAt = Math.min(Date.now() + (d.retryInMs ?? 60_000), l.nextAt);
				if (d.action === "wake" && !l.paused) { fire(l, reason, d); return; }
				save(); refreshStatus();
			});
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

	function fire(l: Loop, reason: "due" | "catch-up" | "manual", gate?: GateDecision) {
		l.fires += 1;
		l.lastFiredAt = Date.now();
		l.lastWokeAt = l.lastFiredAt;
		phase = { state: "queued", id: l.id };
		phaseAt = Date.now();
		if (reason !== "manual") l.nextAt = nextFor(l, Date.now());
		save();
		// One line: a gate's reason may hold newlines (a JSON "\n"), and readers of the header
		// (the model, and any extension that recognises loop turns) take it to end at the line's closing "]".
		const why = gate ? ` · gate: ${gate.reason.replace(/\s*[\r\n]+\s*/g, " ").trim()}` : "";
		const header = `[loop ${l.id} · ${desc(l)} · fire #${l.fires}${reason === "due" ? "" : ` · ${reason}`}${why}]`;
		const evidence = gate?.context ? `\n\n<gate-context>\n${gate.context}\n</gate-context>` : "";
		// A prompt template is expanded here from its file (fresh each fire), so the
		// header and gate context survive intact; see prompt.ts.
		let commands: CommandInfo[] = [];
		try { commands = (pi as any).getCommands?.() ?? []; } catch { /* older Pi */ }
		const { text, expand } = compose(l.prompt, header, evidence, ctx?.cwd ?? process.cwd(), commands);
		pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: expand });
		refreshStatus();
	}

	function tick() {
		if (!ctx) return;
		if (readOnly) {
			if (!claimLock()) return;
			readOnly = false;
			loops = load();
			reconcile();
		}
		const now = Date.now();
		// One loop per tick: a burst after sleep should not queue five turns at once.
		// A fired prompt that never reached the transcript (dropped queue) must not read "queued" forever.
		if (phase?.state === "queued" && now - phaseAt > 2 * TICK_MS && ctx.isIdle?.() && !ctx.hasPendingMessages?.()) phase = undefined;
		const due = loops.filter(l => !l.paused && !gating.has(l.id) && l.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt)[0];
		if (!due) { refreshStatus(); return; }
		if (now - due.nextAt > TICK_MS * 4 && due.catchUp === "none") {
			// Missed by more than a minute (sleep, long turn): short loops just realign.
			due.nextAt = nextFor(due, now);
			save(); refreshStatus();
			return;
		}
		const reason = now - due.nextAt > TICK_MS * 4 ? "catch-up" : "due";
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
		readOnly = !claimLock();
		if (!readOnly) reconcile();
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

	pi.on("agent_settled", (_event, c) => {
		if (phase?.state !== "running" || c?.isIdle?.() === false) return;
		phase = undefined;
		refreshStatus();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (herdrPane && !readOnly) herdr.clear();
		if (!readOnly) releaseLock();
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
				const n = loops.length; loops = []; save(); refreshStatus();
				notify(`removed ${n} loop${n === 1 ? "" : "s"}`); return;
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
						const l = find(target)!; fire(l, "manual"); notify(`fired ${l.id}`); return;
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

	function gateConfig(p: { gate?: string; maxSleep?: string; gateTimeout?: string; gateOnError?: string }): GateConfig {
		const command = p.gate!.trim();
		const r = resolveGate(ctx!.cwd, command);
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
			"Create, list, delete, pause, resume, fire, gate or test recurring prompts (loops) in this session. A loop re-sends its prompt " +
			"to this same session on a schedule; the resulting turn shares this conversation's context. Use it when the user asks " +
			"for something to happen periodically, daily at a time, or 'every N minutes'. Interval default is 10m; `at` is a daily " +
			"wall-clock time HH:MM in the loop's time zone (DST-aware): `timezone` if given, else the configured loop.timezone " +
			"setting, else the machine's zone; `list` shows the default. Loops persist across session restarts and fire only while a Pi session is open in this project. " +
			"A loop may have a gate (a script in the project) that runs when it is due and decides whether the model wakes; `gate` sets or removes it, `test` runs it once without waking, `run` always wakes.",
		promptSnippet: "Schedule recurring prompts in this session (/loop): create, list, delete, pause, resume, run",
		promptGuidelines: [
			"When the user asks for a recurring or daily task in this session, use loop_manage rather than a one-off reminder; state the id and next fire time.",
			"Loop prompts should say where the result goes (a file, a message, a script): a loop turn's output stays in this session unless the prompt sends it somewhere.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("create"), Type.Literal("list"), Type.Literal("delete"),
				Type.Literal("pause"), Type.Literal("resume"), Type.Literal("run"), Type.Literal("gate"), Type.Literal("test"),
			]),
			prompt: Type.Optional(Type.String({ description: "create: the prompt to re-send each time." })),
			every: Type.Optional(Type.String({ description: "create: fixed interval like 5m, 2h, 1d. Default 10m. Mutually exclusive with `at`." })),
			at: Type.Optional(Type.String({ description: "create: daily wall-clock time HH:MM in the loop's time zone." })),
			timezone: Type.Optional(Type.String({ description: "create with `at` or a whole-day `every` (1d, 7d): IANA zone such as America/Chicago. Omit to follow the configured default." })),
			id: Type.Optional(Type.String({ description: "Loop id (or unique prefix). Optional custom id on create." })),
			gate: Type.Optional(Type.String({ description: "create or gate: executable inside the project (e.g. .pi/gates/check) run when the loop is due; it prints {action: skip|wake|defer, reason, context?, retryIn?} and only `wake` starts a model turn. With action gate, an empty string removes the gate." })),
			maxSleep: Type.Optional(Type.String({ description: "With gate: wake anyway once this long has passed since the last wake, e.g. 12h." })),
			gateTimeout: Type.Optional(Type.String({ description: "With gate: kill the gate after this long (default 60s, e.g. 2m); a timeout counts as a gate error, which wakes the model." })),
			gateOnError: Type.Optional(Type.String({ description: "With gate: what a gate error does, wake (default) or skip. A failing gate wakes once, then only every 6h until it succeeds again." })),
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
						fire(l, "manual"); return `fired ${l.id}; its prompt runs after this turn`;
					}
					case "gate": {
						if (!p.id) throw new Error("id is required");
						return setGate(p.id, p.gate?.trim() ? gateConfig(p) : undefined);
					}
					case "create": {
						if (!p.prompt?.trim()) throw new Error("prompt is required");
						if (p.every && p.at) throw new Error("use either every or at");
						const tz = p.timezone ? validZone(p.timezone) : undefined;
						if (p.timezone && !tz) throw new Error(`unknown time zone "${p.timezone}"; use an IANA name like America/Chicago`);
						
						let schedule: Schedule;
						if (p.at) { const a = parseAt(p.at); if (!a) throw new Error("at must be HH:MM"); schedule = { kind: "at", ...a }; }
						else {
							const ms = p.every ? parseInterval(p.every) : DEFAULT_INTERVAL_MS;
							if (ms === undefined) throw new Error("every must look like 5m, 2h or 1d");
							if (ms < MIN_INTERVAL_MS) throw new Error("minimum interval is 1m");
							schedule = { kind: "every", ms };
						}
						const r = add(schedule, p.prompt.trim(), p.id, tz, p.gate?.trim() ? gateConfig(p) : undefined);
						if (typeof r === "string") throw new Error(r);
						return `created loop ${r.id}: ${desc(r)}, next fire ${when(r)}, catch-up ${r.catchUp}${r.gate ? `; ${gateText(r)}` : ""}`;
					}
				}
			})();
			return { content: [{ type: "text", text }], details: { loops } };
		},
	});
}
