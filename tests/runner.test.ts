// End-to-end tests for runners (runner.ts, RUNNERS.md): a loop's run as an ordinary agent session in a terminal.
// The session that runs the loops is the real `pi` binary in RPC mode, as in e2e.test.ts. The terminal comes from
// tests/fixtures/pty-terminals.ts, a provider that runs each run in a real pseudo-terminal (no multiplexer). The
// run is the real interactive Pi (runner pi), or tests/fixtures/fake-agent.mjs behind the command-runner contract:
// a stand-in for another agent, whose hooks are pi-loop's own bin/loop-run.mjs, so it proves the contract without
// a second vendor's model. No model answers unless PI_E2E_PROVIDER and PI_E2E_MODEL select one (see e2e.test.ts).
//
// Run: node --experimental-strip-types --test tests/runner.test.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const PTY = path.join(PACKAGE, "tests", "fixtures", "pty-terminals.ts");
const FAKE = path.join(PACKAGE, "tests", "fixtures", "fake-agent.mjs");
const LOOP_RUN = path.join(PACKAGE, "bin", "loop-run.mjs");
const PI = process.env.PI_BIN || "pi";
const PROVIDER = process.env.PI_E2E_PROVIDER, MODEL = process.env.PI_E2E_MODEL;
const real = PROVIDER && MODEL ? false : "set PI_E2E_PROVIDER and PI_E2E_MODEL to opt in to live-model tests";

for (const k of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_SESSION_ID", "PI_SESSION_FILE", "HC_TERMINAL_ID", "HC_SOCKET", "HC_TERMINAL_SOCKET"]) delete process.env[k];

function tmp(t: any, prefix: string) {
	const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** The fake agent as a runner described in settings, as a person would describe Claude Code or Codex. */
const FAKE_RUNNER = {
	command: ["node", FAKE, "{channel}/settings.json"],
	prompt: "argv", promptArgs: ["{prompt}"],
	modes: { fresh: [] },
	files: { "settings.json": { hooks: {
		SessionStart: ["{hook} event started"], UserPromptSubmit: ["{hook} event prompt"], PostToolUse: ["{hook} event tool"],
		Answer: ["{hook} event answer stop=error content=false error=overloaded"],
		Notification: ["{hook} event dialog"], Stop: ["{hook} event idle"], SessionEnd: ["{hook} event exit"],
	} } },
};

interface Opts { live?: boolean; settings?: object; projectSettings?: object; provider?: boolean; env?: Record<string, string> }

function project(t: any, o: Opts = {}) {
	// Registered before the folders' own removal (after-hooks run in order), so the pids they record are still there.
	let p: P | undefined;
	t.after(() => { if (p) kill(p); });
	const cwd = tmp(t, "pi-loop-rn-cwd-"), agent = tmp(t, "pi-loop-rn-agent-"), pty = tmp(t, "pi-loop-rn-pty-"), sessions = tmp(t, "pi-loop-rn-sessions-");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	let model: object = { defaultProvider: "closed", defaultModel: "none" };
	fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { closed: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "none", models: [{ id: "none" }] } } }));
	if (o.live) {
		if (real) throw new Error(real);
		if (process.env.PI_E2E_MODELS_FILE) {
			const config = JSON.parse(fs.readFileSync(process.env.PI_E2E_MODELS_FILE, "utf8"));
			fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { [PROVIDER!]: config.providers[PROVIDER!] } }), { mode: 0o600 });
		}
		if (process.env.PI_E2E_AUTH_FILE) fs.symlinkSync(path.resolve(process.env.PI_E2E_AUTH_FILE), path.join(agent, "auth.json"));
		model = { defaultProvider: PROVIDER, defaultModel: MODEL, defaultThinkingLevel: "off" };
	}
	fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ ...model, retry: { enabled: false }, defaultProjectTrust: "always", ...(o.settings ?? {}) }));
	fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ loop: { judge: "off", deepJudge: "off", runners: { fake: FAKE_RUNNER } }, ...(o.projectSettings ?? {}) }));
	p = { cwd, agent, pty, sessions, log: path.join(pty, "terminals.jsonl"), loops: () => JSON.parse(fs.readFileSync(path.join(cwd, ".pi/loops.json"), "utf8")) };
	return p;
}
interface P { cwd: string; agent: string; pty: string; sessions: string; log: string; loops: () => any[] }

class Host {
	proc: ChildProcessWithoutNullStreams;
	lines: any[] = [];
	private buf = ""; private seq = 0;
	constructor(t: any, p: P, o: Opts = {}) {
		this.proc = spawn(PI, ["--mode", "rpc", "--session-dir", p.sessions, "-e", PACKAGE, ...(o.provider === false ? [] : ["-e", PTY])], {
			cwd: p.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: p.agent, PTY_DIR: p.pty, PTY_LOG: p.log, FAKE_LOOP_RUN: LOOP_RUN, ...(o.env ?? {}) },
		});
		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (d: string) => {
			this.buf += d; let i;
			while ((i = this.buf.indexOf("\n")) >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); try { this.lines.push(JSON.parse(l)); } catch { /* */ } }
		});
		t.after(() => { if (this.proc.exitCode === null) this.proc.kill("SIGKILL"); });
	}
	async send(cmd: object): Promise<any> {
		const id = `r${++this.seq}`;
		this.proc.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
		return until("an answer", () => this.lines.find(l => l.type === "response" && l.id === id), 30_000);
	}
	async command(text: string) {
		const from = this.lines.length;
		const r = await this.send({ type: "prompt", message: text });
		assert.equal(r.success, true, JSON.stringify(r));
		await new Promise(res => setTimeout(res, 300));
		return this.lines.slice(from).filter(l => l.method === "notify").map(l => l.message).join("\n");
	}
	async ready() { await this.send({ type: "get_state" }); await new Promise(r => setTimeout(r, 1500)); }
}

async function until<T>(what: string, check: () => T | undefined | false, ms = 60_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		let v: any; try { v = check(); } catch { v = undefined; }
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 300));
	}
}
const loopOf = (p: P, id: string) => p.loops().find((l: any) => l.id === id);
const terminals = (p: P): any[] => { try { return fs.readFileSync(p.log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const screen = (p: P, id: string) => { try { return fs.readFileSync(path.join(p.pty, `${id}.out`), "utf8"); } catch { return ""; } };
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const events = (r: any) => fs.readFileSync(path.join(r.terminal.channel, "events.jsonl"), "utf8").trim().split("\n").map((l: string) => JSON.parse(l));
/** Kill what a test left in its terminals: the pty helpers, and the agents (they lead their own sessions), by every pid their channels recorded. */
function kill(p: P) {
	const pids: number[] = [];
	try { for (const l of fs.readFileSync(p.log, "utf8").trim().split("\n").filter(Boolean)) pids.push(JSON.parse(l).pid); } catch { /* none */ }
	try {
		const root = path.join(p.cwd, ".pi", "loop-state");
		for (const loop of fs.readdirSync(root)) for (const run of fs.readdirSync(path.join(root, loop, "runs"))) {
			for (const l of fs.readFileSync(path.join(root, loop, "runs", run, "events.jsonl"), "utf8").split("\n")) { try { const e = JSON.parse(l); if (e.pid) pids.push(Number(e.pid)); } catch { /* */ } }
		}
	} catch { /* none */ }
	for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
}
/** project() already cleans up; kept so the tests read as before. */
function cleanup(_t: any, _p: P) {}

async function fireFake(t: any, script: string, extra: { settings?: object; runner?: object } = {}) {
	const projectSettings = extra.runner ? { loop: { judge: "off", deepJudge: "off", runners: { fake: { ...FAKE_RUNNER, ...extra.runner } } } } : undefined;
	const p = project(t, { ...(projectSettings ? { projectSettings } : {}) });
	cleanup(t, p);
	const host = new Host(t, p, { env: { FAKE_SCRIPT: script } });
	await host.ready();
	await host.command("/loop 1h --fresh --runner fake check the fake");
	const id = p.loops()[0].id;
	assert.equal(p.loops()[0].runner, "fake");
	await host.command(`/loop run ${id}`);
	return { p, host, id };
}

// ------------------------------------------------------------------ the contract, with a stand-in agent --

test("contract: a command runner's run starts in a terminal, counts as fired once its prompt hook fires, and its report reaches the loop", { timeout: 90_000 }, async t => {
	const { p, id } = await fireFake(t, "work report stay");
	const r = await until("the run recorded", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 45_000);
	assert.equal(r.acceptance, "accepted");
	assert.equal(r.result, "FAKE_OK");
	assert.equal(r.findings, false);
	assert.equal(loopOf(p, id).fires, 1);
	const [term] = terminals(p);
	assert.equal(term.runner, "fake");
	assert.equal(r.terminal.terminal, term.id);
	assert.match(screen(p, term.id), /fake agent: \[loop /, "its prompt (with the loop's header) reached it on its command line");
	assert.match(screen(p, term.id), /Reported\./);
	const es = events(r).map((e: any) => e.e);
	for (const e of ["spawned", "started", "prompt", "tool", "idle"]) assert.ok(es.includes(e), `${e} in ${es}`);
	// It stayed open after its turn (an interactive session): kept, not killed, for its keepOpen.
	assert.ok(alive(r.terminal.pid), "its session stays open after the run is recorded");
});

test("contract: findings and an ask from the run's report reach the loop and the owner", { timeout: 90_000 }, async t => {
	const { p, host, id } = await fireFake(t, "report-ask");
	const r = await until("the run recorded", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 45_000);
	assert.equal(r.findings, true);
	assert.equal(r.ask, "Approve the fake");
	const msgs = await host.send({ type: "get_messages" });
	assert.ok((msgs.data?.messages ?? []).some((m: any) => m.customType === "loop-result" && /Approve the fake/.test(JSON.stringify(m.content))), "the ask reached the conversation");
});

test("contract: a run that crashes mid-turn is recorded failed, not left running", { timeout: 90_000 }, async t => {
	const { p, id } = await fireFake(t, "work crash");
	const r = await until("the run recorded", () => ["done", "failed"].includes(loopOf(p, id)?.lastRun?.status) && loopOf(p, id).lastRun, 45_000);
	assert.equal(r.status, "failed");
	assert.match(r.result, /exited before the run finished/);
});

test("contract: a run that hangs is stopped after the runner's stallAfter and recorded failed", { timeout: 120_000 }, async t => {
	const { p, id } = await fireFake(t, "hang", { runner: { stallAfter: "1m" } });
	await until("it works", () => loopOf(p, id)?.lastRun?.status === "running", 30_000);
	const r = await until("the run recorded", () => loopOf(p, id)?.lastRun?.status === "failed" && loopOf(p, id).lastRun, 100_000);
	assert.match(r.result, /no sign of progress/);
	await until("its process ended", () => !alive(r.terminal.pid), 15_000);
});

test("contract: a dialog nobody answers doesn't hold the run for ever: it ends, saying it needed you", { timeout: 150_000 }, async t => {
	const { p, id } = await fireFake(t, "dialog", { runner: { dialogWait: "1m" } });
	const r = await until("the run recorded", () => ["done", "failed"].includes(loopOf(p, id)?.lastRun?.status) && loopOf(p, id).lastRun, 120_000);
	assert.match(r.needsYou ?? "", /Allow the fake/);
	assert.match(r.result, /nobody answered its dialog/);
	await until("its process ended", () => !alive(r.terminal.pid), 15_000);
});

test("contract: a run closed by hand while it works is recorded failed, said as closed", { timeout: 90_000 }, async t => {
	const { p, id } = await fireFake(t, "hang");
	const r0 = await until("it works", () => loopOf(p, id)?.lastRun?.status === "running" && loopOf(p, id).lastRun, 30_000);
	process.kill(r0.terminal.pid, "SIGTERM"); // as closing its terminal would
	const r = await until("the run recorded", () => loopOf(p, id)?.lastRun?.status === "failed" && loopOf(p, id).lastRun, 30_000);
	assert.match(r.result, /before the run finished/);
});

test("contract: a runner that can't run a fork runs fresh and says so; an unknown runner is refused", { timeout: 60_000 }, async t => {
	const p = project(t); cleanup(t, p);
	const host = new Host(t, p, { env: { FAKE_SCRIPT: "report" } });
	await host.ready();
	assert.match(await host.command("/loop 1h --runner nope check"), /no runner "nope"/);
	await host.command("/loop 1h --fork --runner fake check the fake");
	const id = p.loops()[0].id;
	const notes = await host.command(`/loop run ${id}`);
	const r = await until("the run recorded", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 45_000);
	assert.equal(r.mode, "fresh");
	await until("said", () => host.lines.some(l => l.method === "notify" && /can't run a fork.*ran fresh/.test(l.message)), 10_000).catch(() => assert.fail(notes));
});

test("contract: with no terminal provider a terminal runner fails clearly, without a hidden child instead", { timeout: 60_000 }, async t => {
	const p = project(t);
	const host = new Host(t, p, { provider: false, env: { FAKE_SCRIPT: "report" } });
	await host.ready();
	await host.command("/loop 1h --fresh --runner pi check");
	const id = p.loops()[0].id;
	await host.command(`/loop run ${id}`);
	const r = await until("the run recorded", () => loopOf(p, id)?.lastRun?.status === "failed" && loopOf(p, id).lastRun, 20_000);
	assert.match(r.result, /nothing here supplies one/);
	assert.equal(r.acceptance, "not_accepted");
	assert.equal(loopOf(p, id).fires, 0, "not counted as fired");
});

test("contract: a run still going when the loop's session quits is picked up by the next, not run twice", { timeout: 120_000 }, async t => {
	const p = project(t); cleanup(t, p);
	const env = { FAKE_SCRIPT: "work work work work work work work work work work work work report stay" };
	const host = new Host(t, p, { env });
	await host.ready();
	await host.command("/loop 1h --fresh --runner fake check the fake");
	const id = p.loops()[0].id;
	await host.command(`/loop run ${id}`);
	await until("it works", () => loopOf(p, id)?.lastRun?.status === "running", 30_000);
	host.proc.kill("SIGTERM");
	await until("the host gone", () => host.proc.exitCode !== null || host.proc.signalCode !== null, 15_000);
	assert.equal(loopOf(p, id).lastRun.status, "running", "left running in its terminal, not interrupted");
	const next = new Host(t, p, { env });
	await next.ready();
	const r = await until("recorded by the next session", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 60_000);
	assert.equal(r.result, "FAKE_OK");
	assert.equal(loopOf(p, id).fires, 1);
	assert.equal(terminals(p).length, 1, "one terminal: nothing started again");
});

test("contract: a crashed loop session's terminal run is picked up too; one that finished meanwhile is recorded from its channel", { timeout: 120_000 }, async t => {
	const p = project(t); cleanup(t, p);
	const env = { FAKE_SCRIPT: "work work work report" };
	const host = new Host(t, p, { env });
	await host.ready();
	await host.command("/loop 1h --fresh --runner fake check the fake");
	const id = p.loops()[0].id;
	await host.command(`/loop run ${id}`);
	await until("it works", () => loopOf(p, id)?.lastRun?.status === "running", 30_000);
	host.proc.kill("SIGKILL");
	await new Promise(r => setTimeout(r, 6_000)); // it finishes while no session follows it
	const next = new Host(t, p, { env });
	await next.ready();
	const r = await until("recorded by the next session", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 30_000);
	assert.equal(r.result, "FAKE_OK");
	assert.equal(terminals(p).length, 1);
});

// ------------------------------------------------------------------------------- the Pi runner --

test("pi runner: the run is an interactive Pi in its terminal (no watcher); its prompt is accepted there, and a model error is recorded", { timeout: 90_000 }, async t => {
	const p = project(t, { projectSettings: { loop: { runner: "pi", judge: "off", deepJudge: "off" } } }); cleanup(t, p);
	const host = new Host(t, p);
	await host.ready();
	const heard: any[] = [];
	await host.command("/loop 1h --fresh say hi");
	const id = p.loops()[0].id;
	assert.match(await host.command("/loop"), /runner pi \(loop\.runner\)/);
	await host.command(`/loop run ${id}`);
	const r = await until("the run recorded", () => ["done", "failed"].includes(loopOf(p, id)?.lastRun?.status) && loopOf(p, id).lastRun, 60_000);
	assert.equal(r.acceptance, "accepted", "Pi in its terminal took the prompt");
	assert.equal(r.status, "failed"); // the closed model can't answer
	assert.match(r.result, /model error/);
	const [term] = terminals(p);
	assert.equal(term.runner, "pi");
	const s = screen(p, term.id);
	assert.match(s, /loop .* #1/, "an interactive Pi drew its session in the terminal");
	assert.ok(!/PI_LOOP_WATCH/.test(fs.readFileSync(path.join(r.terminal.channel, "run.sh"), "utf8")), "no watcher in front of it");
	assert.ok(r.session && fs.existsSync(r.session), "its own Pi session file");
	assert.ok(!fs.existsSync(path.join(r.terminal.channel, "env.sh")), "its environment file is gone once read");
	void heard;
});

test("pi runner: a dialog in the run is declined after dialogWait when nobody answers, and it says it needs you", { timeout: 150_000 }, async t => {
	const ext = path.join(tmp(t, "pi-loop-rn-ext-"), "dialog.ts");
	fs.writeFileSync(ext, `export default function (pi: any) {
	pi.registerCommand("ask-dialog", { description: "asks", handler: async (_a: string, ctx: any) => { const ok = await ctx.ui.confirm("Deploy now?", "e2e"); ctx.ui.notify("answered " + ok); } });
}\n`);
	const p = project(t, { settings: { extensions: [ext] }, projectSettings: { loop: { runner: "pi", judge: "off", deepJudge: "off", runners: { pi: { dialogWait: "1m" } } } } }); cleanup(t, p);
	const host = new Host(t, p);
	await host.ready();
	await host.command("/loop 1h --fresh /ask-dialog");
	const id = p.loops()[0].id;
	await host.command(`/loop run ${id}`);
	const r = await until("the run recorded", () => ["done", "failed"].includes(loopOf(p, id)?.lastRun?.status) && loopOf(p, id).lastRun, 120_000);
	assert.match(r.needsYou ?? "", /Deploy now/, JSON.stringify(r));
	assert.equal(r.status, "done");
	assert.match(screen(p, r.terminal.terminal), /answered false/, "declined in the run's own Pi");
});

test("pi runner: a real model run reports through loop_report; the session stays open in its terminal, and a thread's next fire continues it there", { skip: real, timeout: 300_000 }, async t => {
	const p = project(t, { live: true, projectSettings: { loop: { runner: "pi", judge: "off", deepJudge: "off" } } }); cleanup(t, p);
	const host = new Host(t, p);
	await host.ready();
	await host.command("/loop 1h --thread Reply with the word hello. Then call loop_report with findings false and summary the number of times you have been asked this, as digits only. Do nothing else.");
	const id = p.loops()[0].id;
	await host.command(`/loop run ${id}`);
	const r1 = await until("the first run", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 180_000);
	assert.equal(r1.result, "1");
	assert.equal(r1.model, `${PROVIDER}/${MODEL}`);
	assert.ok(alive(r1.terminal.pid), "its session stays open after the run");
	await host.command(`/loop run ${id}`);
	const r2 = await until("the second run", () => loopOf(p, id)?.lastRun?.fire === 2 && loopOf(p, id).lastRun.status === "done" && loopOf(p, id).lastRun, 180_000);
	assert.equal(r2.result, "2", "the same conversation carried on");
	assert.equal(terminals(p).length, 1, "in the same terminal");
	assert.equal(r2.terminal.pid, r1.terminal.pid);
});

test("pi runner: a fallback list moves on when the first model can't answer, in a new terminal, and the fire counts once", { skip: real, timeout: 300_000 }, async t => {
	// The first model's endpoint is closed: Pi retries the connection error once and gives up, having done nothing.
	const p = project(t, { live: true, settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 200 } }, projectSettings: { loop: { runner: "pi", judge: "off", deepJudge: "off" } } }); cleanup(t, p);
	const host = new Host(t, p);
	await host.ready();
	await host.command(`/loop 1h --fresh --model closed/none,${PROVIDER}/${MODEL} Call loop_report with findings false and summary FELL_BACK. Do nothing else.`);
	const id = p.loops()[0].id;
	await host.command(`/loop run ${id}`);
	const r = await until("the run recorded", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 240_000);
	assert.equal(r.result, "FELL_BACK");
	assert.equal(r.model, `${PROVIDER}/${MODEL}`);
	assert.equal(r.fallback, true);
	assert.ok(r.passedOver?.some((x: any) => x.model === "closed/none"), JSON.stringify(r.passedOver));
	assert.equal(loopOf(p, id).fires, 1);
});
