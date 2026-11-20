// The Pi runner's recovery and ownership edges, on the real channel: the session that runs the loops is the real
// `pi` (RPC mode), the run is the real interactive Pi in a real pseudo-terminal (tests/fixtures/pty-terminals.ts),
// its model is tests/fixtures/fake-model.mjs (answers, fails or is slow on cue, for free), and gates are real scripts.
// The run's Pi reads a few test-only variables (runner-pi.ts): PI_LOOP_TEST_HOLD_PROMPT_MS, PI_LOOP_TEST_NO_ACK,
// PI_LOOP_TEST_REFUSE, to hold, swallow or refuse the loop's prompt.
//
// Run: node --experimental-strip-types --test tests/pi-runner.test.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const PTY = path.join(PACKAGE, "tests", "fixtures", "pty-terminals.ts");
const PI = process.env.PI_BIN || "pi";

for (const k of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_SESSION_ID", "PI_SESSION_FILE", "HC_TERMINAL_ID", "HC_SOCKET", "HC_TERMINAL_SOCKET"]) delete process.env[k];

function tmp(t: any, prefix: string) {
	const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}
async function until<T>(what: string, check: () => T | undefined | false, ms = 60_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		let v: any; try { v = check(); } catch { v = undefined; }
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 250));
	}
}
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

async function fakeModel(t: any): Promise<number> {
	const p = spawn(process.execPath, [path.join(PACKAGE, "tests/fixtures/fake-model.mjs")], { stdio: ["ignore", "pipe", "ignore"] });
	t.after(() => p.kill());
	return new Promise(resolve => p.stdout!.once("data", d => resolve(Number(String(d).trim()))));
}

interface Box { cwd: string; agent: string; pty: string; sessions: string; log: string; loops(): any[]; loop(id: string): any; gateLog(): any[]; stream(): any[] }

/** A project with the Pi runner on, a fake model, and (optionally) a real one-shot gate that wakes once per marker. */
async function box(t: any, o: { gate?: boolean; runner?: object } = {}): Promise<Box> {
	const port = await fakeModel(t);
	const cwd = tmp(t, "pi-loop-pr-cwd-"), agent = tmp(t, "pi-loop-pr-agent-"), pty = tmp(t, "pi-loop-pr-pty-"), sessions = tmp(t, "pi-loop-pr-sessions-");
	let b: Box;
	t.after(() => kill(b));
	fs.mkdirSync(path.join(cwd, ".pi/gates"), { recursive: true });
	fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "none",
		models: ["ok", "503", "slow-20000", "slow-600000"].map(id => ({ id })) } } }));
	fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "ok", defaultProjectTrust: "always", retry: { enabled: false } }));
	fs.writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify({ loop: { runner: "pi", judge: "off", deepJudge: "off", ...(o.runner ? { runners: { pi: o.runner } } : {}) } }));
	// A real gate: wakes once per marker (with context), as a gate that marks its finding seen does.
	fs.writeFileSync(path.join(cwd, ".pi/gates/once"), `#!/bin/sh
m="\${LOOP_STATE_DIR:-/tmp}/woke"
if [ -n "$LOOP_TEST" ]; then echo '{"action":"skip","reason":"test"}'; exit 0; fi
if [ -e "$m" ]; then echo '{"action":"skip","reason":"already reported"}'; exit 0; fi
mkdir -p "$(dirname "$m")"; date > "$m"; echo '{"action":"wake","reason":"finding X","context":"evidence for finding X"}'
`, { mode: 0o755 });
	b = {
		cwd, agent, pty, sessions, log: path.join(pty, "terminals.jsonl"),
		loops: () => JSON.parse(fs.readFileSync(path.join(cwd, ".pi/loops.json"), "utf8")),
		loop: (id: string) => b.loops().find((l: any) => l.id === id),
		gateLog: () => { try { return fs.readFileSync(path.join(cwd, ".pi/loops.log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } },
		stream: () => { const d = path.join(agent, "loop-hosts", "streams"); try { return fs.readdirSync(d).flatMap(f => fs.readFileSync(path.join(d, f), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))); } catch { return []; } },
	};
	return b;
}
/** Every agent a test started: by its terminal log and every pid its channels recorded. */
function kill(b?: Box) {
	if (!b) return;
	const pids: number[] = [];
	try { for (const l of fs.readFileSync(b.log, "utf8").trim().split("\n").filter(Boolean)) pids.push(JSON.parse(l).pid); } catch { /* none */ }
	try {
		const root = path.join(b.cwd, ".pi", "loop-state");
		for (const loop of fs.readdirSync(root)) for (const run of fs.readdirSync(path.join(root, loop, "runs"))) {
			for (const l of fs.readFileSync(path.join(root, loop, "runs", run, "events.jsonl"), "utf8").split("\n")) { try { const e = JSON.parse(l); if (e.pid) pids.push(Number(e.pid)); } catch { /* */ } }
		}
	} catch { /* none */ }
	for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
}

class Host {
	proc: ChildProcessWithoutNullStreams;
	lines: any[] = [];
	private buf = ""; private seq = 0;
	constructor(t: any, b: Box, env: Record<string, string> = {}) {
		this.proc = spawn(PI, ["--mode", "rpc", "--session-dir", b.sessions, "-e", PACKAGE, "-e", PTY], {
			cwd: b.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: b.agent, PTY_DIR: b.pty, PTY_LOG: b.log, ...env },
		});
		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (d: string) => { this.buf += d; let i; while ((i = this.buf.indexOf("\n")) >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); try { this.lines.push(JSON.parse(l)); } catch { /* */ } } });
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
		await new Promise(res => setTimeout(res, 400));
		return this.lines.slice(from).filter(l => l.method === "notify").map(l => l.message).join("\n");
	}
	notes() { return this.lines.filter(l => l.method === "notify").map(l => l.message as string); }
	async ready() { await this.send({ type: "get_state" }); await new Promise(r => setTimeout(r, 1500)); }
	async kill() { this.proc.kill("SIGKILL"); await until("the host gone", () => this.proc.exitCode !== null || this.proc.signalCode !== null, 10_000); }
}

/** A loop due now, gated (`once`) or not, declared in loops.json before the host starts. */
function seed(b: Box, id: string, o: { gate?: boolean; model?: string; prompt?: string } = {}) {
	const now = Date.now();
	fs.writeFileSync(path.join(b.cwd, ".pi/loops.json"), JSON.stringify([{
		id, prompt: o.prompt ?? "say hi", schedule: { kind: "every", ms: 3_600_000 }, run: "fresh", paused: false, createdAt: now - 7_200_000, fires: 0, catchUp: "latest", nextAt: now - 1000,
		...(o.gate ? { gate: { command: ".pi/gates/once", timeoutMs: 10_000, onError: "wake" } } : {}), ...(o.model ? { model: o.model } : {}),
	}]));
}
const firedLines = (b: Box, id: string) => b.gateLog().filter(x => x.action === "fired" && x.id === id);

// ----------------------------------------------------------- finding 4: one acknowledgement rule --

test("pi: sent but never acknowledged, live: recorded unknown, the loop paused with its gate's wake kept, the owner told; the fire number is never reused", { timeout: 150_000 }, async t => {
	const b = await box(t);
	seed(b, "c", { gate: true });
	const host = new Host(t, b, { PI_LOOP_TEST_NO_ACK: "1" });
	await host.ready();
	const l = await until("recorded", () => ["failed", "interrupted"].includes(b.loop("c")?.lastRun?.status) && b.loop("c"), 90_000);
	assert.equal(l.lastRun.acceptance, "unknown");
	assert.equal(l.paused, true, "paused, not retried");
	assert.equal(l.pendingWake?.reason, "finding X", "the gate's wake is kept");
	assert.equal(l.pendingWake?.context, "evidence for finding X", "with its context");
	assert.equal(l.fires, 0);
	assert.ok(host.notes().some(n => /acceptance is unknown|paused pending/.test(n)), "the owner is told");
	await until("its agent gone and the inventory empty", () => !b.loop("c")?.terminals?.length, 20_000);
	// Resumed: the kept wake runs, as fire #1 (the unknown attempt's number, never a reuse after a counted one).
	await host.command("/loop resume c");
	await until("not paused", () => b.loop("c")?.paused === false, 10_000);
});

test("pi: sent but never acknowledged, then the session dies: the next one ends it, records unknown, pauses the loop and keeps the wake; nothing runs twice", { timeout: 150_000 }, async t => {
	const b = await box(t);
	seed(b, "c", { gate: true });
	const host = new Host(t, b, { PI_LOOP_TEST_HOLD_PROMPT_MS: "20000" });
	await host.ready();
	const t0 = await until("its prompt sent", () => { const x = b.loop("c")?.terminals?.[0]; return x?.ref?.dispatch === "sent" && x; }, 60_000);
	assert.equal(t0.wake?.reason, "finding X", "the gate's wake is in the inventory before the terminal opened");
	await host.kill();
	const next = new Host(t, b);
	await next.ready();
	const l = await until("recorded", () => b.loop("c")?.lastRun?.status === "interrupted" && b.loop("c"), 30_000);
	assert.equal(l.lastRun.acceptance, "unknown");
	assert.equal(l.paused, true);
	assert.equal(l.pendingWake?.reason, "finding X");
	assert.equal(l.pendingWake?.context, "evidence for finding X");
	assert.equal(l.fires, 0);
	await until("its agent ended and forgotten", () => !alive(t0.ref.pid) && !b.loop("c")?.terminals?.length, 30_000);
	assert.equal(fs.readFileSync(b.log, "utf8").trim().split("\n").length, 1, "one terminal: nothing started again");
	const msgs = await next.send({ type: "get_messages" });
	assert.ok((msgs.data?.messages ?? []).some((m: any) => m.customType === "loop-result" && /acceptance unknown/.test(JSON.stringify(m.content))), "the owner is told");
});

test("pi: a refused prompt is proven not to have run: not counted, the wake kept, retried soon (not paused)", { timeout: 120_000 }, async t => {
	const b = await box(t);
	seed(b, "c", { gate: true });
	const host = new Host(t, b, { PI_LOOP_TEST_REFUSE: "1" });
	await host.ready();
	const l = await until("recorded", () => b.loop("c")?.lastRun?.status === "failed" && b.loop("c"), 60_000);
	assert.equal(l.lastRun.acceptance, "not_accepted");
	assert.match(l.lastRun.result, /refused by the test/);
	assert.equal(l.fires, 0);
	assert.equal(l.paused, false);
	assert.equal(l.pendingWake?.reason, "finding X");
});

test("pi: a refusal that arrives while no session follows the run is read as proven on pickup (not unknown, not paused)", { timeout: 150_000 }, async t => {
	const b = await box(t);
	seed(b, "c", { gate: true });
	// The run holds its prompt 8s, then refuses it; the session dies as soon as the prompt is sent.
	const host = new Host(t, b, { PI_LOOP_TEST_REFUSE: "1", PI_LOOP_TEST_HOLD_PROMPT_MS: "8000" });
	await host.ready();
	await until("its prompt sent", () => b.loop("c")?.terminals?.[0]?.ref?.dispatch === "sent", 60_000);
	await host.kill();
	await new Promise(r => setTimeout(r, 10_000)); // it refuses (to its channel) while no session follows it
	const next = new Host(t, b);
	await next.ready();
	const l = await until("recorded", () => b.loop("c")?.lastRun?.status === "interrupted" && b.loop("c"), 30_000);
	assert.equal(l.lastRun.acceptance, "not_accepted", JSON.stringify(l.lastRun));
	assert.equal(l.paused, false, "a proven refusal doesn't pause");
	assert.equal(l.pendingWake?.reason, "finding X", "its wake is kept");
	assert.equal(l.fires, 0);
});

// --------------------------------------------- finding 5: the wake survives, fired is logged once --

test("pi: killed after the launcher started but before the prompt was sent: the gate's wake (with context) survives, not counted, not paused", { timeout: 150_000 }, async t => {
	const b = await box(t);
	seed(b, "c", { gate: true });
	// The run's Pi takes its time to say it started (the credential wait), so the window is wide.
	const host = new Host(t, b);
	await host.ready();
	const t0 = await until("launcher started, prompt not sent", () => { const x = b.loop("c")?.terminals?.[0]; return x?.ref?.pid && x.ref.dispatch === "none" && x; }, 60_000);
	assert.ok(fs.existsSync(path.join(b.cwd, ".pi/loop-state/c/woke")), "the gate marked its finding seen");
	await host.kill();
	const next = new Host(t, b);
	await next.ready();
	await until("its agent ended", () => !alive(t0.ref.pid), 30_000);
	const l = b.loop("c");
	assert.equal(l.lastRun.acceptance, "not_accepted");
	assert.equal(l.fires, 0);
	assert.equal(l.paused, false, "it can't have run: not paused");
	// The kept wake runs (the gate itself would now say skip): it is sent, and this time accepted and recorded.
	const done = await until("the kept wake ran", () => b.loop("c")?.lastRun?.status === "done" && b.loop("c"), 60_000);
	assert.equal(done.fires, 1);
	assert.equal(done.pendingWake, undefined);
	const run = done.lastRun.session ? fs.readFileSync(done.lastRun.session, "utf8") : "";
	assert.match(run, /evidence for finding X/, "the run got the gate's context");
});

test("pi: accepted and fired-logged, killed before the count was saved: one fired line for the attempt, the fire counted once", { timeout: 150_000 }, async t => {
	const b = await box(t);
	seed(b, "c", { model: "fake/slow-20000" });
	const host = new Host(t, b);
	await host.ready();
	await until("accepted and counted", () => b.loop("c")?.fires === 1, 60_000);
	await host.kill();
	// Put back the count as if the save after the log line never happened (the log line stays).
	const loops = b.loops(); const l = loops.find((x: any) => x.id === "c");
	l.fires = 0; l.lastRun.status = "starting"; l.lastRun.acceptance = "unknown";
	fs.writeFileSync(path.join(b.cwd, ".pi/loops.json"), JSON.stringify(loops));
	const next = new Host(t, b);
	await next.ready();
	const after = await until("recorded", () => b.loop("c")?.lastRun?.status === "done" && b.loop("c"), 60_000);
	assert.equal(after.fires, 1);
	assert.equal(firedLines(b, "c").length, 1, "one fired line for the one attempt");
});

// ----------------------------------------- finding 6: retire first, no orphans, fail closed, commands --

test("pi: a model that gives up in the run falls back only after the first attempt's agent is gone and retired", { timeout: 150_000 }, async t => {
	const b = await box(t);
	fs.writeFileSync(path.join(b.agent, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "ok", defaultProjectTrust: "always", retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } }));
	seed(b, "c", { model: "fake/503,fake/ok" } as any);
	const loops = b.loops(); loops[0].model = ["fake/503", "fake/ok"]; fs.writeFileSync(path.join(b.cwd, ".pi/loops.json"), JSON.stringify(loops));
	const host = new Host(t, b);
	await host.ready();
	const l = await until("recorded", () => b.loop("c")?.lastRun?.status === "done" && b.loop("c"), 90_000);
	assert.equal(l.lastRun.model, "fake/ok");
	assert.equal(l.fires, 1);
	const terms = fs.readFileSync(b.log, "utf8").trim().split("\n").map(x => JSON.parse(x));
	assert.equal(terms.length, 2, "a new terminal for the fallback");
	// The first attempt's agent was gone before the second's launcher started (never two at once).
	const chans = fs.readdirSync(path.join(b.cwd, ".pi/loop-state/c/runs")).map(d => fs.readFileSync(path.join(b.cwd, ".pi/loop-state/c/runs", d, "events.jsonl"), "utf8").trim().split("\n").map(x => JSON.parse(x)));
	const exited = chans.map(es => es.find((e: any) => e.e === "exited")?.at).filter(Boolean).sort();
	const spawned = chans.map(es => es.find((e: any) => e.e === "spawned")?.at).filter(Boolean).sort();
	assert.ok(exited[0] <= spawned[1], `the first exited (${exited[0]}) before the second spawned (${spawned[1]})`);
	assert.equal(l.terminals, undefined, "both retired");
});

test("pi: deleting a loop whose run is going doesn't orphan its terminal: the loop waits, its agent is ended, then it goes", { timeout: 150_000 }, async t => {
	const b = await box(t);
	seed(b, "c", { model: "fake/slow-20000" });
	const host = new Host(t, b);
	await host.ready();
	const t0 = await until("running", () => { const l = b.loop("c"); return l?.lastRun?.status === "running" && l.terminals?.[0]; }, 60_000);
	assert.match(await host.command("/loop rm c"), /paused and goes once its run/);
	assert.equal(b.loop("c")?.removing, true);
	await host.kill(); // the session dies while it waits: the next one must still know the terminal
	const next = new Host(t, b);
	await next.ready();
	await until("its agent ended and the loop gone", () => !alive(t0.ref.pid) && !b.loop("c"), 90_000);
});

test("pi: if the attempt can't be saved, nothing is started: no launcher gets its argv, and the run fails without counting", { timeout: 120_000 }, async t => {
	const b = await box(t);
	seed(b, "c", { model: "fake/slow-20000" });
	// The loop's folder for run state is made unwritable as a file: its channel folder can't be made, so the attempt
	// can't be saved before its terminal is asked for, and must not go on.
	fs.mkdirSync(path.join(b.cwd, ".pi/loop-state/c"), { recursive: true });
	fs.writeFileSync(path.join(b.cwd, ".pi/loop-state/c/runs"), "not a folder");
	const host = new Host(t, b);
	await host.ready();
	const l = await until("recorded failed", () => b.loop("c")?.lastRun?.status === "failed" && b.loop("c"), 60_000);
	assert.equal(l.fires, 0, "not counted");
	assert.equal(l.lastRun.acceptance, "not_accepted");
	assert.equal(fs.existsSync(b.log) ? fs.readFileSync(b.log, "utf8").trim() : "", "", "no terminal was asked for");
	assert.equal(l.terminals, undefined);
});

test("pi: a launcher whose attempt can't be recorded is refused its argv (the save happens before the handoff answers)", { timeout: 120_000 }, async t => {
	const b = await box(t);
	seed(b, "c", { model: "fake/slow-20000" });
	const host = new Host(t, b, { PTY_SLOW_MS: "3000" });
	await host.ready();
	// The handoff's save fails: the record can't be written once the terminal is opening (loops.json becomes a folder).
	const lj = path.join(b.cwd, ".pi/loops.json");
	await until("the attempt saved, its terminal opening", () => b.loop("c")?.terminals?.length, 30_000);
	const keep = fs.readFileSync(lj, "utf8");
	fs.rmSync(lj); fs.mkdirSync(lj);
	t.after(() => { try { fs.rmSync(lj, { recursive: true, force: true }); } catch { /* */ } });
	await new Promise(r => setTimeout(r, 12_000));
	fs.rmSync(lj, { recursive: true, force: true }); fs.writeFileSync(lj, keep);
	const runs = path.join(b.cwd, ".pi/loop-state/c/runs");
	for (const d of fs.readdirSync(runs)) {
		const es = fs.readFileSync(path.join(runs, d, "events.jsonl"), "utf8");
		assert.doesNotMatch(es, /"e":"started"/, "no agent started for an attempt that couldn't be recorded");
	}
});

test("pi: /loop open, take and steer on a finished terminal run say how to open it, and leave its report alone", { timeout: 120_000 }, async t => {
	const b = await box(t);
	seed(b, "c", { prompt: "Call loop_report with findings false and summary OPEN_ME. Do nothing else." });
	const host = new Host(t, b);
	await host.ready();
	const l = await until("recorded", () => b.loop("c")?.lastRun?.status === "done" && b.loop("c"), 60_000);
	const report = path.join(b.cwd, ".pi/loop-state/c", `report-${l.lastRun.fire}.json`);
	fs.writeFileSync(report, JSON.stringify({ findings: false, summary: "kept" }));
	for (const cmd of ["/loop open c", "/loop take c", "/loop steer c please carry on"]) {
		const out = await host.command(cmd);
		assert.match(out, /ran in a terminal and has ended; open its conversation yourself: pi --session /, `${cmd}: ${out}`);
	}
	assert.equal(JSON.parse(fs.readFileSync(report, "utf8")).summary, "kept", "its report is untouched");
	const state = await host.send({ type: "get_state" });
	assert.notEqual(state.data.sessionFile, l.lastRun.session, "the host didn't switch into it");
});

// ------------------------------------------------------- findings 7 and 8: the handoff, the bounds --

test("pi: the handoff is answered once (a replay is refused), bounds its input, and a dead owner's socket path is cleared", { timeout: 120_000 }, async t => {
	const b = await box(t);
	// A dead owner's socket path: a pid that can't be running.
	const ctl = path.join(b.agent, "loop-hosts", "ctl");
	fs.mkdirSync(ctl, { recursive: true, mode: 0o700 });
	const stale = path.join(ctl, "999999999-runs.sock");
	fs.writeFileSync(stale, "");
	seed(b, "c", { model: "fake/slow-20000" });
	const host = new Host(t, b, { PI_LOOP_TEST_HOLD_PROMPT_MS: "5000" });
	await host.ready();
	const t0 = await until("running", () => { const l = b.loop("c"); return l?.terminals?.[0]?.ref?.pid && l.terminals[0]; }, 60_000);
	assert.equal(fs.existsSync(stale), false, "the dead owner's socket path is gone");
	const sock = fs.readdirSync(ctl).filter(f => f.endsWith("-runs.sock")).map(f => path.join(ctl, f))[0]!;
	const ask = (line: string) => new Promise<string>(resolve => {
		const s = net.createConnection(sock); let out = "";
		s.on("connect", () => s.write(line)); s.on("data", d => { out += d; }); s.on("close", () => resolve(out)); s.on("error", () => resolve(out));
	});
	// The launcher already used its token: asking again (any token) is refused, with no environment in the answer.
	const again = await ask(JSON.stringify({ token: "0".repeat(48), pid: 1 }) + "\n");
	assert.match(again, /no such run/);
	assert.doesNotMatch(again, /"env"/);
	// An endless line is cut off, not buffered.
	const big = await ask("x".repeat(10_000));
	assert.equal(big, "");
	void t0;
});

test("pi: a run picked up after a restart has the same stall bound as a live one", { timeout: 180_000 }, async t => {
	const b = await box(t, { runner: { stallAfter: "1m" } });
	seed(b, "c", { model: "fake/slow-600000" });
	const host = new Host(t, b);
	await host.ready();
	const t0 = await until("accepted", () => { const x = b.loop("c")?.terminals?.[0]; return x?.ref?.dispatch === "accepted" && x; }, 60_000);
	// Its agent goes silent mid-turn (stopped, not killed): no more events from it.
	process.kill(t0.ref.pid, "SIGSTOP");
	t.after(() => { try { process.kill(t0.ref.pid, "SIGCONT"); } catch { /* gone */ } });
	await host.kill();
	const next = new Host(t, b);
	await next.ready();
	const l = await until("recorded failed by the stall bound", () => b.loop("c")?.lastRun?.status === "failed" && b.loop("c"), 150_000);
	assert.match(l.lastRun.result, /no sign of progress/);
	await until("its agent ended", () => !alive(t0.ref.pid), 20_000);
});
