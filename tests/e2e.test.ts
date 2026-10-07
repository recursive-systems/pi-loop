// End-to-end tests: the real `pi` binary in RPC mode, with this extension loaded from the
// repository, in a throwaway project and agent dir. No mocks: loops are made with the real
// /loop command, fire on the extension's real 15 s tick, run real gate scripts, and are
// observed through Pi's own RPC events and the files the extension writes.
//
// The one thing not exercised is the model's reply. The agent dir configures a provider whose
// endpoint is closed (127.0.0.1:9), so Pi accepts a woken turn's user message (the loop header,
// gate context, expanded template: what this extension controls) and the model call after it
// fails without anything answering in its place.
//
// Live-model tests are opt-in: PI_E2E_PROVIDER and PI_E2E_MODEL select the route.
// For a gateway, PI_E2E_MODELS_FILE and PI_E2E_AUTH_FILE point at existing Pi files.
// Only synthetic test data is sent. No automatic paid-provider fallback; without explicit
// selection the model cases skip. The waiting case runs a real model and real bash sleep.
//
// Needs `pi` on PATH (PI_BIN to override). Run: npm test
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The repository as a Pi package: the extension and its skill, as `pi install` would load them.
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const PI = process.env.PI_BIN || "pi";
const TICK = 15_000;
const PROVIDER = process.env.PI_E2E_PROVIDER;
const MODEL = process.env.PI_E2E_MODEL;
const real = PROVIDER && MODEL ? false : "set PI_E2E_PROVIDER and PI_E2E_MODEL to opt in to live-model tests";

function configureLiveModel(agent: string) {
	if (real) throw new Error(real);
	if (process.env.PI_E2E_MODELS_FILE) {
		const config = JSON.parse(fs.readFileSync(process.env.PI_E2E_MODELS_FILE, "utf8"));
		const provider = config.providers?.[PROVIDER!];
		if (!provider) throw new Error("Selected provider is absent from PI_E2E_MODELS_FILE");
		fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { [PROVIDER!]: provider } }), { mode: 0o600 });
	}
	// Existing API-key auth is read by Pi, not copied into logs or command arguments.
	if (process.env.PI_E2E_AUTH_FILE) fs.symlinkSync(path.resolve(process.env.PI_E2E_AUTH_FILE), path.join(agent, "auth.json"));
}

for (const k of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_SESSION_ID", "PI_SESSION_FILE"]) delete process.env[k];

function tmp(t: any, prefix: string) {
	const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function project(t: any, opts: { tz?: string; loops?: any[]; gates?: Record<string, string>; prompts?: Record<string, string>; fireworks?: boolean; files?: Record<string, string> } = {}) {
	const cwd = tmp(t, "pi-loop-e2e-cwd-"), agent = tmp(t, "pi-loop-e2e-agent-");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { closed: {
		baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "none", models: [{ id: "none" }] } } }));
	for (const [rel, body] of Object.entries(opts.files ?? {})) {
		fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
		fs.writeFileSync(path.join(cwd, rel), body, { mode: rel.includes("/gates/") ? 0o755 : 0o644 });
	}
	if (opts.fireworks) configureLiveModel(agent);
	const model = opts.fireworks ? { defaultProvider: PROVIDER, defaultModel: MODEL, defaultThinkingLevel: "off" } : { defaultProvider: "closed", defaultModel: "none" };
	fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ ...model, retry: { enabled: false }, ...(opts.tz ? { loop: { timezone: opts.tz } } : {}) }));
	if (opts.loops) fs.writeFileSync(path.join(cwd, ".pi/loops.json"), JSON.stringify(opts.loops));
	for (const [name, body] of Object.entries(opts.gates ?? {})) {
		fs.mkdirSync(path.join(cwd, ".pi/gates"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi/gates", name), body, { mode: 0o755 });
	}
	for (const [name, body] of Object.entries(opts.prompts ?? {})) {
		fs.mkdirSync(path.join(cwd, ".pi/prompts"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi/prompts", `${name}.md`), body);
	}
	return { cwd, agent, loops: () => JSON.parse(fs.readFileSync(path.join(cwd, ".pi/loops.json"), "utf8")) };
}

/** A real Pi in RPC mode. Records every JSON line it prints. */
class Pi {
	proc: ChildProcessWithoutNullStreams;
	lines: any[] = [];
	private buf = "";
	private seq = 0;

	constructor(t: any, p: { cwd: string; agent: string }, env: Record<string, string> = {}, opts: { sessionDir?: string; args?: string[]; asPackage?: boolean } = {}) {
		// asPackage: pi-loop comes from the project's .pi/settings.json packages, as on a box, not from -e.
		this.proc = spawn(PI, ["--mode", "rpc", ...(opts.sessionDir ? ["--session-dir", opts.sessionDir] : ["--no-session"]), ...(opts.asPackage ? [] : ["-e", PACKAGE]), ...(opts.args ?? [])], {
			cwd: p.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: p.agent, ...env },
		});
		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (d: string) => {
			this.buf += d;
			let i;
			while ((i = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, i).replace(/\r$/, "");
				this.buf = this.buf.slice(i + 1);
				try { this.lines.push(JSON.parse(line)); } catch { /* not a record */ }
			}
		});
		t.after(() => this.stop());
	}

	send(cmd: object) {
		const id = `t${++this.seq}`;
		this.proc.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
		return this.waitFor(l => l.type === "response" && l.id === id, 30_000);
	}

	/** Run a slash command and return the notifications it produced. */
	async command(text: string) {
		const from = this.lines.length;
		const r = await this.send({ type: "prompt", message: text });
		assert.equal(r.success, true, JSON.stringify(r));
		await new Promise(res => setTimeout(res, 300));
		return this.notes(from);
	}

	notes(from = 0) {
		return this.lines.slice(from).filter(l => l.type === "extension_ui_request" && l.method === "notify").map(l => l.message as string).join("\n");
	}

	/** User messages Pi accepted into the conversation (what a loop fire sends). */
	userMessages() {
		return this.lines.filter(l => l.type === "message_start" && l.message?.role === "user")
			.map(l => (l.message.content ?? []).map((c: any) => c.text ?? "").join(""));
	}

	/** Prompt the model and wait for the whole run to settle. */
	async ask(text: string, ms = 240_000) {
		const from = this.lines.length;
		const r = await this.send({ type: "prompt", message: text });
		assert.equal(r.success, true, JSON.stringify(r));
		const end = Date.now() + ms;
		for (;;) {
			if (this.lines.slice(from).some(l => l.type === "agent_end") && !this.lines.slice(from).some((l, i, a) => l.type === "agent_start" && !a.slice(i).some(x => x.type === "agent_end"))) return;
			if (Date.now() > end) throw new Error("the model run did not finish in time");
			await new Promise(res => setTimeout(res, 500));
		}
	}

	async waitFor(pred: (l: any) => boolean, ms: number) {
		const end = Date.now() + ms;
		for (;;) {
			const hit = this.lines.find(pred);
			if (hit) return hit;
			if (Date.now() > end) throw new Error(`timed out; last lines:\n${this.lines.slice(-8).map(l => JSON.stringify(l).slice(0, 300)).join("\n")}`);
			await new Promise(res => setTimeout(res, 100));
		}
	}

	async waitForUser(pattern: RegExp, ms = TICK * 2 + 5_000) {
		const end = Date.now() + ms;
		for (;;) {
			const hit = this.userMessages().find(m => pattern.test(m));
			if (hit) return hit;
			if (Date.now() > end) throw new Error(`no user message matching ${pattern}; got: ${JSON.stringify(this.userMessages())}`);
			await new Promise(res => setTimeout(res, 200));
		}
	}

	stop() {
		if (this.proc.exitCode !== null) return;
		this.proc.kill("SIGTERM");
		// A Pi still starting up when asked to stop may not exit: don't let it hold the suite.
		setTimeout(() => { if (this.proc.exitCode === null) this.proc.kill("SIGKILL"); }, 10_000).unref();
	}

	async ready() {
		await this.send({ type: "get_state" });
	}
}

const due = (id: string, extra: object = {}) => ({
	id, prompt: `do ${id}`, schedule: { kind: "every", ms: 3_600_000 }, paused: false,
	createdAt: Date.now() - 7_200_000, fires: 0, catchUp: "latest", nextAt: Date.now() - 1_000, ...extra,
});

test("/loop makes, lists, pauses, resumes and removes a loop, kept in .pi/loops.json", async t => {
	const p = project(t);
	const pi = new Pi(t, p);
	await pi.ready();
	assert.match(await pi.command("/loop 2h check the build"), /loop check-the-build: every 2h, next/);
	const [l] = p.loops();
	assert.equal(l.prompt, "check the build");
	assert.deepEqual(l.schedule, { kind: "every", ms: 7_200_000 });
	assert.ok(Math.abs(l.nextAt - (Date.now() + 7_200_000)) < 60_000);
	assert.equal((fs.statSync(path.join(p.cwd, ".pi/loops.json")).mode & 0o777), 0o600);

	assert.match(await pi.command("/loop"), /check-the-build/);
	await pi.command("/loop pause check-the-build");
	assert.equal(p.loops()[0].paused, true);
	await pi.command("/loop resume check-the-build");
	assert.equal(p.loops()[0].paused, false);
	await pi.command("/loop rm check-the-build");
	assert.deepEqual(p.loops(), []);
});

test("an `at` time follows daylight saving in the configured zone", async t => {
	const p = project(t, { tz: "America/Chicago" });
	const pi = new Pi(t, p);
	await pi.ready();
	await pi.command("/loop at 07:30 morning report");
	const [l] = p.loops();
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
		.formatToParts(new Date(l.nextAt)).map(x => [x.type, x.value]));
	assert.equal(`${parts.hour}:${parts.minute}`, "07:30", "07:30 Chicago wall time, whatever the UTC offset that day");
	assert.ok(l.nextAt > Date.now() && l.nextAt <= Date.now() + 86_400_000 + 3_600_000);
	assert.match(await pi.command("/loop"), /default zone America\/Chicago/);
});

test("a project's loops have one owner; a second session is read-only", async t => {
	const p = project(t);
	const first = new Pi(t, p);
	await first.ready();
	await first.command("/loop 1h one");
	const second = new Pi(t, p);
	await second.ready();
	assert.match(await second.command("/loop 1h two"), /owned by pid/);
	assert.deepEqual(p.loops().map((l: any) => l.id), ["one"]);
});

test("a loop that came due while no session ran fires once on start, with its header", async t => {
	const p = project(t, { loops: [due("nightly")] });
	const pi = new Pi(t, p);
	await pi.ready();
	const msg = await pi.waitForUser(/^\[loop nightly · every 1h · fire #1/);
	assert.match(msg, /do nightly/);
	assert.equal(p.loops()[0].fires, 1);
	assert.ok(p.loops()[0].nextAt > Date.now());
});

test("a gate that says skip keeps the model asleep and logs why", async t => {
	const p = project(t, {
		loops: [due("quiet", { gate: { command: ".pi/gates/quiet", timeoutMs: 10_000, onError: "wake" } })],
		gates: { quiet: '#!/bin/sh\necho \'{"action":"skip","reason":"nothing new"}\'\n' },
	});
	const pi = new Pi(t, p);
	await pi.ready();
	const log = path.join(p.cwd, ".pi/loops.log.jsonl");
	const end = Date.now() + TICK * 2 + 5_000;
	while (!fs.existsSync(log) && Date.now() < end) await new Promise(r => setTimeout(r, 200));
	const entries = fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
	assert.ok(entries.some(e => e.id === "quiet" && e.action === "skip" && /nothing new/.test(e.reason)), JSON.stringify(entries));
	assert.deepEqual(pi.userMessages(), [], "no model turn");
	assert.equal(p.loops()[0].fires, 0);
});

test("a gate that says wake passes its reason and context to the model", async t => {
	const p = project(t, {
		loops: [due("svc", { gate: { command: ".pi/gates/svc", timeoutMs: 10_000, onError: "wake" } })],
		gates: { svc: `#!/bin/sh\necho "$LOOP_ID" > "$LOOP_STATE_DIR/seen"\necho '{"action":"wake","reason":"api down","context":"503 since 09:00"}'\n` },
	});
	const pi = new Pi(t, p);
	await pi.ready();
	const msg = await pi.waitForUser(/^\[loop svc /);
	assert.match(msg, /· gate: api down\]/);
	assert.match(msg, /<gate-context>\n503 since 09:00\n<\/gate-context>/);
	assert.equal(fs.readFileSync(path.join(p.cwd, ".pi/loop-state/svc/seen"), "utf8").trim(), "svc");
});

test("a broken gate wakes the model once instead of keeping it asleep", async t => {
	const p = project(t, {
		loops: [due("flaky", { gate: { command: ".pi/gates/flaky", timeoutMs: 10_000, onError: "wake" } })],
		gates: { flaky: "#!/bin/sh\necho oops >&2\nexit 3\n" },
	});
	const pi = new Pi(t, p);
	await pi.ready();
	const msg = await pi.waitForUser(/^\[loop flaky /);
	assert.match(msg, /gate: /);
	assert.equal(p.loops()[0].gateErrors, 1);
});

test("/loop test runs the gate once and never wakes", async t => {
	const p = project(t, {
		loops: [{ ...due("probe"), nextAt: Date.now() + 3_600_000, gate: { command: ".pi/gates/probe", timeoutMs: 10_000, onError: "wake" } }],
		gates: { probe: '#!/bin/sh\necho "{\\"action\\":\\"wake\\",\\"reason\\":\\"test=$LOOP_TEST\\"}"\n' },
	});
	const pi = new Pi(t, p);
	await pi.ready();
	assert.match(await pi.command("/loop test probe"), /wake.*test=1/s);
	await new Promise(r => setTimeout(r, 1_000));
	assert.deepEqual(pi.userMessages().filter(m => m.startsWith("[loop")), []);
});

test("a prompt template is read from disk when the loop fires, header and gate context intact", async t => {
	const p = project(t, {
		loops: [{ ...due("check"), prompt: "/check" }],
		prompts: { check: "Look at the queue and reply ok unless something is stuck." },
	});
	const pi = new Pi(t, p);
	await pi.ready();
	const msg = await pi.waitForUser(/^\[loop check /);
	assert.match(msg, /Look at the queue and reply ok unless something is stuck\./);
});

test("a woken loop runs a real model turn to the end", { skip: real }, async t => {
	const p = project(t, { fireworks: true, loops: [{ ...due("ping"), prompt: "Reply with exactly the word pong and nothing else." }] });
	const pi = new Pi(t, p);
	await pi.ready();
	await pi.waitForUser(/^\[loop ping · every 1h · fire #1/);
	const end = await pi.waitFor(l => l.type === "agent_end", 120_000);
	const reply = (end.messages ?? []).filter((m: any) => m.role === "assistant")
		.flatMap((m: any) => m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
	assert.match(reply, /pong/i, JSON.stringify(end).slice(0, 800));
	assert.equal(p.loops()[0].fires, 1);
});

test("the package ships the pi-loop skill", async t => {
	const pi = new Pi(t, project(t));
	const r = await pi.send({ type: "get_commands" });
	assert.ok(r.data.commands.some((c: any) => c.name === "skill:pi-loop" && c.source === "skill"), JSON.stringify(r.data.commands.map((c: any) => c.name)));
});

// The next two check that an agent, given only what this package puts in its context, uses it correctly.

test("asked for a daily job in a stated time zone, the agent makes one `at` loop in that zone", { skip: real }, async t => {
	const p = project(t, { fireworks: true });
	const pi = new Pi(t, p);
	await pi.ready();
	await pi.ask("Every day at 08:00 Tokyo time, write today's date to dates.txt in this folder.");
	const loops = p.loops();
	assert.equal(loops.length, 1, JSON.stringify(loops));
	assert.deepEqual([loops[0].schedule.kind, loops[0].schedule.hh, loops[0].schedule.mm, loops[0].tz], ["at", 8, 0, "Asia/Tokyo"]);
});

test("asked for a frequent check, the agent gates the loop so quiet fires cost no turn", { skip: real }, async t => {
	const p = project(t, { fireworks: true });
	fs.writeFileSync(path.join(p.cwd, "status.txt"), "OK\n");
	const pi = new Pi(t, p);
	await pi.ready();
	await pi.ask("Every 5 minutes, check status.txt in this folder. Only bother the model when it says FAILED; then append a line to incidents.txt.");
	const [l] = p.loops();
	assert.ok(l?.gate?.command, `a gate was set: ${JSON.stringify(p.loops())}`);
	assert.ok(l.schedule.kind === "every" && l.schedule.ms <= 600_000, JSON.stringify(l.schedule));
	const gate = path.join(p.cwd, l.gate.command);
	assert.ok(fs.statSync(gate).mode & 0o100, "the gate is executable");
	// Run the agent's gate as the extension would, against both states of the file.
	const { execFileSync } = await import("node:child_process");
	const run = () => {
		const out = execFileSync(gate, [], { cwd: p.cwd, env: { ...process.env, LOOP_ID: l.id, LOOP_STATE_DIR: tmp(t, "gate-state-"), LOOP_TEST: "1" }, encoding: "utf8" });
		return JSON.parse(out.trim().split("\n").pop()!).action;
	};
	assert.equal(run(), "skip", "quiet when status.txt says OK");
	fs.writeFileSync(path.join(p.cwd, "status.txt"), "FAILED\n");
	assert.equal(run(), "wake", "wakes when status.txt says FAILED");
});


// ---------------------------------------------------------------- waiting for a free session --

test("due loops wait while the session is busy, then fire once each, highest priority first, gate run when free", { skip: real, timeout: 420_000 }, async t => {
	const p = project(t, {
		fireworks: true,
		loops: [
			{ ...due("often"), prompt: "Reply with the single word ok.", schedule: { kind: "every", ms: 60_000 }, catchUp: "none", nextAt: Date.now() + 15_000,
				gate: { command: ".pi/gates/stamp", timeoutMs: 10_000, onError: "wake" } },
			{ ...due("urgent"), prompt: "Run this exact bash command and nothing else: sleep 35. Then reply with the single word done.", priority: 5, nextAt: Date.now() + 15_000 },
		],
		gates: { stamp: '#!/bin/sh\ndate +%s >> "$LOOP_STATE_DIR/ran"\necho \'{"action":"wake","reason":"checked"}\'\n' },
	});
	const pi = new Pi(t, p);
	await pi.ready();
	const r = await pi.send({ type: "prompt", message: "Run this exact bash command and nothing else: sleep 90. Then reply with the single word done." });
	assert.equal(r.success, true);
	await pi.waitFor(l => l.type === "tool_execution_start" && l.toolName === "bash", 60_000);
	// Both come due while the agent works; "often" (every 1m) comes due again too.
	await pi.waitFor(l => l.type === "agent_settled", 240_000);
	const freedAt = Math.floor(Date.now() / 1000);
	const loopsBefore = pi.userMessages().filter(m => m.startsWith("[loop")).length;
	assert.equal(loopsBefore, 0, "nothing fired or queued while the agent worked");
	assert.ok(!fs.existsSync(path.join(p.cwd, ".pi/loop-state/often/ran")), "the gate doesn't run while the agent works");

	const first = await pi.waitForUser(/^\[loop /, TICK * 2 + 5_000);
	assert.match(first, /^\[loop urgent · every 1h · fire #1 · waited \d+m/, "the higher priority goes first, marked as having waited");
	await pi.waitFor(l => l.type === "tool_execution_start" && l.toolName === "bash" && pi.lines.indexOf(l) > pi.lines.findIndex(x => x.type === "message_start" && JSON.stringify(x).includes("[loop urgent")), 60_000);
	await new Promise(res => setTimeout(res, TICK + 3_000));
	assert.equal(pi.userMessages().filter(m => m.startsWith("[loop")).length, 1, "one at a time: the next waits for this turn");

	const second = await pi.waitForUser(/^\[loop often /, 180_000);
	assert.match(second, /fire #1 · waited .* · gate: checked\]/, "a short loop that waited fires once instead of being skipped");
	const ran = fs.readFileSync(path.join(p.cwd, ".pi/loop-state/often/ran"), "utf8").trim().split("\n").map(Number);
	assert.equal(ran.length, 1, "its gate ran once");
	assert.ok(ran[0] >= freedAt, "and only after the session was free");
	const byId = Object.fromEntries(p.loops().map((l: any) => [l.id, l]));
	assert.equal(byId.often.fires, 1, "no stacked copies");
	assert.equal(byId.urgent.fires, 1);
});

const slowGate = '#!/bin/sh\ndate +%s >> "$LOOP_STATE_DIR/ran"\nsleep 6\nif [ -f "$LOOP_STATE_DIR/told" ]; then echo \'{"action":"skip","reason":"already told"}\'; else touch "$LOOP_STATE_DIR/told"; echo \'{"action":"wake","reason":"queue grew","context":"42 waiting"}\'; fi\n';
// Like real gates, slowGate records what it reported: run again, it has nothing to say.
const gateRan = (cwd: string, id: string) => { try { return fs.readFileSync(path.join(cwd, ".pi/loop-state", id, "ran"), "utf8").trim().split("\n").length; } catch { return 0; } };
async function untilRan(cwd: string, id: string) {
	const end = Date.now() + TICK * 2 + 5_000;
	while (!gateRan(cwd, id) && Date.now() < end) await new Promise(r => setTimeout(r, 200));
}

test("a gate's wake that comes back after the session worked is kept and sent once it's free; the gate isn't run again", { timeout: 120_000 }, async t => {
	const p = project(t, { loops: [due("slow", { gate: { command: ".pi/gates/slow", timeoutMs: 30_000, onError: "wake" } })], gates: { slow: slowGate } });
	const pi = new Pi(t, p);
	await pi.ready();
	await untilRan(p.cwd, "slow");
	await pi.send({ type: "prompt", message: "something else" }); // a run starts (and, with no model here, ends) while the gate runs
	const msg = await pi.waitForUser(/^\[loop slow /, TICK * 3 + 15_000);
	assert.match(msg, /· waited [^·\]]+ · gate: queue grew\]/);
	assert.match(msg, /<gate-context>\n42 waiting\n<\/gate-context>/);
	assert.equal(gateRan(p.cwd, "slow"), 1, "the gate ran once");
	assert.equal(p.loops()[0].fires, 1);
	assert.equal(p.loops()[0].pendingWake, undefined);
});

test("a kept wake is dropped if its loop is redefined before it's sent", { timeout: 120_000 }, async t => {
	const decl = (prompt: string) => JSON.stringify([{ id: "slow", prompt, every: "1h", gate: ".pi/gates/slow", gateTimeout: "30s" }]);
	const p = project(t, { files: { ".pi/loop.json": decl("first"), ".pi/gates/slow": slowGate }, loops: [due("slow", { prompt: "first", source: ".pi/loop.json", rev: 1, gate: { command: ".pi/gates/slow", timeoutMs: 30_000, onError: "wake" } })] });
	const pi = new Pi(t, p);
	await pi.ready();
	await untilRan(p.cwd, "slow");
	await pi.send({ type: "prompt", message: "something else" });
	fs.writeFileSync(path.join(p.cwd, ".pi/loop.json"), decl("second")); // redefined while the gate runs
	await new Promise(r => setTimeout(r, TICK * 2 + 8_000));
	assert.ok(!pi.userMessages().some(m => m.startsWith("[loop slow")), "the old evidence wasn't sent with the new prompt");
	const [l] = p.loops();
	assert.equal(l.prompt, "second");
	assert.equal(l.pendingWake, undefined);
	assert.ok(l.nextAt > Date.now(), "it waits for its next time");
});

test("a session stopped while a gate runs keeps the gate's wake; the next session sends it without running the gate again", { timeout: 120_000 }, async t => {
	const p = project(t, { loops: [due("slow", { gate: { command: ".pi/gates/slow", timeoutMs: 30_000, onError: "wake" } })], gates: { slow: slowGate } });
	const first = new Pi(t, p);
	await first.ready();
	await untilRan(p.cwd, "slow");
	first.proc.kill("SIGTERM");
	await new Promise<void>(r => first.proc.on("exit", () => r()));
	const kept = p.loops()[0].pendingWake;
	assert.equal(kept?.reason, "queue grew", JSON.stringify(p.loops()[0]));
	assert.equal(fs.readFileSync(path.join(p.cwd, ".pi/loops.lock"), "utf8").trim(), "", "the lock was released after the gate finished");
	const second = new Pi(t, p);
	await second.ready();
	const msg = await second.waitForUser(/^\[loop slow /, TICK * 2 + 5_000);
	assert.match(msg, /· gate: queue grew\]/);
	assert.equal(gateRan(p.cwd, "slow"), 1);
});

test("a lock left by a process that is gone, even with its pid reused, is taken over; a live owner's is not", { timeout: 60_000 }, async t => {
	const p = project(t);
	// This test's own pid is alive, but started at another time than the lock says: a reused pid.
	// This test's own pid is alive, but nothing holds the lock: the record is from an owner that is gone.
	fs.writeFileSync(path.join(p.cwd, ".pi/loops.lock"), `${process.pid}\n`);
	fs.writeFileSync(path.join(p.cwd, ".pi/loops.lock.owner"), JSON.stringify({ pid: process.pid, token: "earlier" }));
	const a = new Pi(t, p);
	await a.ready();
	assert.match(await a.command("/loop 1h mine"), /loop mine:/);
	assert.equal(Number(fs.readFileSync(path.join(p.cwd, ".pi/loops.lock"), "utf8").trim()), a.proc.pid);
	const b = new Pi(t, p);
	await b.ready();
	assert.match(await b.command("/loop 1h theirs"), /owned by pid/);
});

test("an owner in another time zone is still recognised as alive", { timeout: 60_000 }, async t => {
	const p = project(t);
	const a = new Pi(t, p, { TZ: "Asia/Tokyo", LC_ALL: "C" });
	await a.ready();
	assert.match(await a.command("/loop 1h mine"), /loop mine:/);
	const b = new Pi(t, p, { TZ: "America/Los_Angeles" });
	await b.ready();
	assert.match(await b.command("/loop 1h theirs"), /owned by pid/);
});

test("several sessions starting at once against a dead owner's lock: exactly one takes it over", { timeout: 60_000 }, async t => {
	const p = project(t);
	fs.writeFileSync(path.join(p.cwd, ".pi/loops.lock"), JSON.stringify({ pid: process.pid, started: "not this process", token: "dead" }));
	const all = [0, 1, 2, 3].map(() => new Pi(t, p));
	await Promise.all(all.map(x => x.ready()));
	const notes = [];
	for (const [i, x] of all.entries()) notes.push(await x.command(`/loop 1h from-${i}`));
	assert.equal(notes.filter(n => !/owned by pid/.test(n)).length, 1, notes.join(" | "));
	assert.equal(p.loops().length, 1);

});

test("at shutdown a running gate is waited for even if its loop was removed meanwhile", { timeout: 120_000 }, async t => {
	const gate = '#!/bin/sh\ndate +%s > "$LOOP_STATE_DIR/began"\nsleep 30\ndate +%s > "$LOOP_STATE_DIR/ended"\necho \'{"action":"skip","reason":"done"}\'\n';
	const p = project(t, { files: { ".pi/loop.json": JSON.stringify([{ id: "slow", prompt: "x", every: "1h", gate: ".pi/gates/slow", gateTimeout: "60s" }]), ".pi/gates/slow": gate },
		loops: [due("slow", { prompt: "x", source: ".pi/loop.json", rev: 1, gate: { command: ".pi/gates/slow", timeoutMs: 60_000, onError: "wake" } })] });
	const pi = new Pi(t, p);
	await pi.ready();
	const state = path.join(p.cwd, ".pi/loop-state/slow");
	const end = Date.now() + TICK * 2 + 5_000;
	while (!fs.existsSync(path.join(state, "began")) && Date.now() < end) await new Promise(r => setTimeout(r, 200));
	fs.writeFileSync(path.join(p.cwd, ".pi/loop.json"), "[]"); // the loop goes away while its gate runs
	await new Promise(r => setTimeout(r, TICK + 1_000));
	assert.ok(!fs.existsSync(path.join(state, "ended")), "the gate is still running");
	pi.proc.kill("SIGTERM");
	const lock = path.join(p.cwd, ".pi/loops.lock");
	const held = () => { try { return fs.readFileSync(lock, "utf8").trim() !== ""; } catch { return false; } };
	while (held()) await new Promise(r => setTimeout(r, 100));
	assert.ok(fs.existsSync(path.join(state, "ended")), "the lock was released only after the gate finished");
});

test("a live owner's lock from an older pi-loop is never taken over", { timeout: 60_000 }, async t => {
	const p = project(t);
	fs.writeFileSync(path.join(p.cwd, ".pi/loops.lock"), `${process.pid} Mon Jan  1 00:00:00 2001`); // older plain format; this test is alive
	const a = new Pi(t, p);
	await a.ready();
	assert.match(await a.command("/loop 1h mine"), /owned by pid/);
});

test("an owner that crashes frees the lock at once: the next session owns the loops", { timeout: 60_000 }, async t => {
	const p = project(t);
	const a = new Pi(t, p);
	await a.ready();
	assert.match(await a.command("/loop 1h mine"), /loop mine:/);
	a.proc.kill("SIGKILL");
	await new Promise<void>(r => a.proc.on("exit", () => r()));
	const b = new Pi(t, p);
	await b.ready();
	const end = Date.now() + 10_000;
	let note = "";
	while (Date.now() < end) { note = await b.command("/loop 1h theirs"); if (!/owned by pid/.test(note)) break; await new Promise(r => setTimeout(r, 500)); }
	assert.match(note, /loop theirs:/);
});

test("a session whose lock helper dies stops writing at once, and takes the loops back when the lock is free", { timeout: 90_000 }, async t => {
	const p = project(t);
	const a = new Pi(t, p);
	await a.ready();
	assert.match(await a.command("/loop 1h first"), /loop first:/);
	const lock = path.join(p.cwd, ".pi/loops.lock");
	const helper = execFileSync("pgrep", ["-f", lock], { encoding: "utf8" }).trim().split("\n").map(Number);
	assert.equal(helper.length, 1, "one lock helper: A's");
	// Another process takes the real lock the moment A's helper is gone, as a second session would.
	process.kill(helper[0], "SIGKILL");
	const other = spawn("perl", ["-e", 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or exit 2; until (flock($f, LOCK_EX | LOCK_NB)) { select(undef, undef, undef, 0.02) } $| = 1; print "ok\\n"; 1 while <STDIN>;', lock]);
	t.after(() => other.kill());
	await new Promise<void>(r => other.stdout.once("data", () => r()));
	assert.match(await a.command("/loop 1h second"), /owned by pid/, "A refuses to change the loops");
	assert.match(a.notes(), /lost its lock/);
	assert.deepEqual(p.loops().map((l: any) => l.prompt), ["first"], "nothing written after the lock was lost");
	// The other holder lets go: A takes the lock back on its next tick and can change the loops again.
	other.stdin.end();
	const end = Date.now() + 40_000;
	let note = "";
	while (Date.now() < end) { note = await a.command("/loop 1h third"); if (!/owned by pid/.test(note)) break; await new Promise(r => setTimeout(r, 1_000)); }
	assert.match(note, /loop third:/);
	assert.deepEqual(p.loops().map((l: any) => l.prompt).sort(), ["first", "third"]);
});

test("two sessions starting at once in a folder: exactly one owns its loops", { timeout: 60_000 }, async t => {
	const p = project(t);
	const [a, b] = [new Pi(t, p), new Pi(t, p)];
	await Promise.all([a.ready(), b.ready()]);
	const notes = [await a.command("/loop 1h from-a"), await b.command("/loop 1h from-b")];
	assert.equal(notes.filter(n => /owned by pid/.test(n)).length, 1, notes.join(" | "));
	assert.equal(p.loops().length, 1);
});

test("/loop run on a loop that is due is that occurrence: it doesn't fire again", { timeout: 90_000 }, async t => {
	const p = project(t, { loops: [{ ...due("hourly"), nextAt: Date.now() + 8_000 }] });
	const pi = new Pi(t, p);
	await pi.ready();
	await new Promise(r => setTimeout(r, 9_000)); // due now, before the first tick looks
	assert.match(await pi.command("/loop run hourly"), /fired hourly/);
	assert.ok(p.loops()[0].nextAt > Date.now() + 3_000_000, "its schedule moved on");
	await new Promise(r => setTimeout(r, TICK * 2 + 2_000));
	assert.equal(pi.userMessages().filter(m => m.startsWith("[loop hourly")).length, 1);
	assert.equal(p.loops()[0].fires, 1);
});

test("a loop whose folder is gone is skipped with a warning; the others keep running", { timeout: 90_000 }, async t => {
	const p = project(t, { loops: [due("lost", { dir: "gone", priority: 9 }), due("fine")] });
	const pi = new Pi(t, p);
	await pi.ready();
	await pi.waitForUser(/^\[loop fine /, TICK * 3 + 5_000);
	assert.match(pi.notes(), /loop lost: dir gone does not exist; skipped/);
	assert.ok(!pi.userMessages().some(m => m.startsWith("[loop lost")));
	assert.ok(p.loops().find((l: any) => l.id === "lost").nextAt > Date.now());
});

// -------------------------------------------------------------------------- loop folders --

const folderFiles = {
	".pi/prompts/check.md": "ROOT CHECK: not this one.",
	"svc/.pi/prompts/check.md": "---\ndescription: svc check\n---\nSVC CHECK: look at the queue.",
	"svc/AGENTS.md": "# Svc\n\nOwn one question: is the queue moving?",
	"svc/.pi/gates/check": '#!/bin/sh\npwd > "$LOOP_STATE_DIR/cwd"\necho \'{"action":"wake","reason":"queue grew"}\'\n',
};

test("a loop with its own folder runs its gate there, uses that folder's template and attaches its context files", async t => {
	const p = project(t, {
		files: folderFiles,
		loops: [{ ...due("svc-check"), prompt: "/check", dir: "svc", context: ["AGENTS.md"], gate: { command: ".pi/gates/check", timeoutMs: 10_000, onError: "wake" } }],
	});
	const pi = new Pi(t, p);
	await pi.ready();
	const msg = await pi.waitForUser(/^\[loop svc-check /);
	assert.match(msg, /· gate: queue grew\]/);
	assert.match(msg, /This loop's folder is svc\/ in the project/);
	assert.match(msg, /<loop-context file="svc\/AGENTS.md">\n# Svc\n\nOwn one question: is the queue moving\?\n<\/loop-context>/);
	assert.match(msg, /SVC CHECK: look at the queue\./);
	assert.doesNotMatch(msg, /ROOT CHECK|description: svc check/);
	const state = path.join(p.cwd, "svc/.pi/loop-state/svc-check");
	assert.equal(fs.realpathSync(fs.readFileSync(path.join(state, "cwd"), "utf8").trim()), fs.realpathSync(path.join(p.cwd, "svc")));
});

// ------------------------------------------------------------------------- declared loops --

test("loops declared in a folder's .pi/loop.json are picked up, follow edits, and go when the declaration does", { timeout: 120_000 }, async t => {
	const decl = (prompt: string) => JSON.stringify({ loops: [{ id: "svc-check", prompt, every: "1h", gate: ".pi/gates/check", maxSleep: "12h", context: ["AGENTS.md"], priority: 2 }] });
	const p = project(t, {
		files: { ...folderFiles, "svc/.pi/loop.json": decl("/check"), "notes/readme.txt": "not a loop folder" },
		// Its run state from an earlier session: kept, and due now.
		loops: [{ ...due("svc-check"), fires: 4, source: "svc/.pi/loop.json", dir: "svc" }],
	});
	const pi = new Pi(t, p);
	await pi.ready();
	const msg = await pi.waitForUser(/^\[loop svc-check · every 1h · fire #5/);
	assert.match(msg, /SVC CHECK: look at the queue\./, "the declared prompt, from the declaring folder");
	let [l] = p.loops();
	assert.deepEqual([l.source, l.dir, l.priority, l.gate.command, l.gate.maxSleepMs], ["svc/.pi/loop.json", "svc", 2, ".pi/gates/check", 43_200_000]);

	assert.match(await pi.command("/loop rm svc-check"), /declared in svc\/.pi\/loop.json; remove it there/);
	fs.writeFileSync(path.join(p.cwd, "svc/.pi/loop.json"), decl("/check now"));
	const end = Date.now() + TICK * 2 + 5_000;
	while (p.loops()[0]?.prompt !== "/check now" && Date.now() < end) await new Promise(r => setTimeout(r, 500));
	assert.equal(p.loops()[0].prompt, "/check now", "an edit to the file changes the loop");
	assert.equal(p.loops()[0].fires, 5, "and keeps its run state");

	fs.writeFileSync(path.join(p.cwd, "svc/.pi/loop.json"), "{ not json");
	await new Promise(r => setTimeout(r, TICK + 2_000));
	assert.equal(p.loops().length, 1, "a broken file leaves its loops as they were");
	assert.match(pi.notes(), /svc\/.pi\/loop.json: .*its loops are left as they were/);

	fs.rmSync(path.join(p.cwd, "svc/.pi/loop.json"));
	const gone = Date.now() + TICK * 2 + 5_000;
	while (p.loops().length && Date.now() < gone) await new Promise(r => setTimeout(r, 500));
	assert.deepEqual(p.loops(), [], "removing the declaration removes the loop");
});

test("a declaration never takes over a loop made with loop_manage; one whose file is gone is removed at start", async t => {
	const p = project(t, {
		files: { ...folderFiles, "svc/.pi/loop.json": JSON.stringify([{ id: "mine", prompt: "/check", every: "1h" }]) },
		loops: [
			{ ...due("mine"), prompt: "my own loop", nextAt: Date.now() + 3_600_000 },
			{ ...due("orphan"), source: "old/.pi/loop.json", nextAt: Date.now() + 3_600_000 },
		],
	});
	const pi = new Pi(t, p);
	await pi.ready();
	await new Promise(r => setTimeout(r, 1_000));
	const loops = p.loops();
	assert.deepEqual(loops.map((l: any) => [l.id, l.prompt, l.source ?? null]), [["mine", "my own loop", null]]);
	assert.match(pi.notes(), /svc\/.pi\/loop.json: loop id mine is already a loop made with loop_manage; rename one/);
});

test("a declaration's paused pauses and resumes the loop when it changes, and only then", { timeout: 90_000 }, async t => {
	const decl = (paused: boolean) => JSON.stringify([{ id: "p", prompt: "/check", every: "1h", paused }]);
	const p = project(t, { files: { ...folderFiles, "svc/.pi/loop.json": decl(true) } });
	const pi = new Pi(t, p);
	await pi.ready();
	await new Promise(r => setTimeout(r, 1_000));
	assert.equal(p.loops()[0].paused, true);
	await pi.command("/loop resume p");
	assert.equal(p.loops()[0].paused, false, "resumed by hand");
	fs.writeFileSync(path.join(p.cwd, "svc/AGENTS.md"), "touched"); // an unrelated change: nothing re-pauses it
	fs.writeFileSync(path.join(p.cwd, "svc/.pi/loop.json"), decl(true) + "\n");
	await new Promise(r => setTimeout(r, TICK + 2_000));
	assert.equal(p.loops()[0].paused, false, "the file still says paused, unchanged: the hand resume holds");
	fs.writeFileSync(path.join(p.cwd, "svc/.pi/loop.json"), decl(false));
	await new Promise(r => setTimeout(r, TICK + 2_000));
	fs.writeFileSync(path.join(p.cwd, "svc/.pi/loop.json"), decl(true));
	const end = Date.now() + TICK * 2 + 5_000;
	while (!p.loops()[0].paused && Date.now() < end) await new Promise(r => setTimeout(r, 500));
	assert.equal(p.loops()[0].paused, true, "a change to paused in the file applies");
});

test("a loop moved from one folder's .pi/loop.json to another's changes hands and keeps its run state", { timeout: 90_000 }, async t => {
	const decl = JSON.stringify([{ id: "moving", prompt: "/check", every: "1h" }]);
	const p = project(t, { files: { ...folderFiles, "svc/.pi/loop.json": decl, "web/.pi/prompts/check.md": "WEB CHECK" } });
	const pi = new Pi(t, p);
	await pi.ready();
	await new Promise(r => setTimeout(r, 1_000));
	const before = p.loops()[0];
	assert.equal(before.source, "svc/.pi/loop.json");
	fs.rmSync(path.join(p.cwd, "svc/.pi/loop.json"));
	fs.writeFileSync(path.join(p.cwd, "web/.pi/loop.json"), decl);
	const end = Date.now() + TICK * 2 + 5_000;
	while (p.loops()[0]?.source !== "web/.pi/loop.json" && Date.now() < end) await new Promise(r => setTimeout(r, 500));
	const [after] = p.loops();
	assert.deepEqual([after?.id, after?.source, after?.dir, after?.createdAt, after?.nextAt], ["moving", "web/.pi/loop.json", "web", before.createdAt, before.nextAt]);
	assert.doesNotMatch(pi.notes(), /already declared/);
});


// ------------------------------------------------------------ background runs (rs-2w9f) --
// A loop can run in the background: a child Pi on a fork of the conversation, the loop's own thread, or a fresh one.
// Each run reports through loop_report; only findings come back, as a quiet note in the main conversation.

/** A Pi with a saved session (a fork needs one), live model, and the folder's loops. */
async function bgSession(t: any, opts: Parameters<typeof project>[1] = {}, settings: object = {}) {
	const p = project(t, { fireworks: true, ...opts });
	if (Object.keys(settings).length) {
		const f = path.join(p.agent, "settings.json");
		fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), ...settings }));
	}
	const sessions = tmp(t, "pi-loop-e2e-sessions-");
	const pi = new Pi(t, p, {}, { sessionDir: sessions });
	await pi.ready();
	return { p, pi, sessions };
}
const loopOf = (p: { loops: () => any[] }, id: string) => p.loops().find((l: any) => l.id === id);
let debugState: (() => string) | undefined;
async function until<T>(what: string, check: () => T | undefined | false, ms = 240_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		let v: any; try { v = check(); } catch { v = undefined; }
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}${debugState ? `\n${debugState()}` : ""}`);
		await new Promise(r => setTimeout(r, 500));
	}
}
async function untilAsync(what: string, check: () => Promise<boolean>, ms = 120_000) {
	const end = Date.now() + ms;
	while (!(await check().catch(() => false))) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 500));
	}
}
async function mainFile(pi: Pi) { return (await pi.send({ type: "get_state" })).data.sessionFile as string; }
/** The loop notes in the session's conversation (Pi writes the file only after its first exchange, so ask Pi). */
async function notesOf(pi: Pi): Promise<string[]> {
	const r = await pi.send({ type: "get_messages" });
	return (r.data?.messages ?? []).filter((m: any) => m.role === "custom" && m.customType === "loop-result").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
}
async function untilNote(pi: Pi, what: string, ms = 240_000) {
	const end = Date.now() + ms;
	for (;;) {
		const n = await notesOf(pi);
		if (n.length) return n.join("\n");
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}${debugState ? `\n${debugState()}` : ""}`);
		await new Promise(r => setTimeout(r, 1000));
	}
}
const lockPid = (cwd: string) => Number(fs.readFileSync(path.join(cwd, ".pi/loops.lock"), "utf8").trim().split(/\s+/)[0]);
const REPORT = (findings: boolean, summary: string, extra = "") => `Then call loop_report with findings ${findings} and summary "${summary}"${extra}. Do nothing else.`;

test("a fresh loop stays alive for an async reader and consumes its completion once", { skip: real, timeout: 480_000 }, async t => {
	const subagents = process.env.PI_E2E_SUBAGENTS;
	if (!subagents || !fs.existsSync(subagents)) return t.skip("set PI_E2E_SUBAGENTS to the installed real pi-subagents extension");
	const { p, pi } = await bgSession(t, { files: {
		".pi/agents/loop-reader.md": "---\nname: loop-reader\ndescription: Harmless integration-test reader\ntools: bash\n---\nPerform only the supplied synthetic test task. Never delegate.\n",
	} }, { extensions: [subagents] });
	const finished = path.join(p.cwd, "reader-finished.txt"), consumed = path.join(p.cwd, "reader-consumed.txt");
	const task = `Use bash once to run: sleep 35; printf READER_RESULT > ${finished}. Then return exactly READER_RESULT. No other work.`;
	const prompt = `This is a two-phase integration test. First call subagent action list with capabilities true. ` +
		`Then launch exactly one loop-reader using subagent, async true, context fresh, model ${PROVIDER}/${MODEL}, task ${JSON.stringify(task)}. ` +
		`After launch, end this turn with exactly WAITING_FOR_READER. Do not call loop_report yet, do not poll or wait, do not start another child. ` +
		`When the native background completion notice arrives in a later turn, consume it once: use bash to append exactly one line READER_RESULT to ${consumed}. ` +
		`Only then call loop_report with findings false and summary READER_CONSUMED. Never report the launch as completed work.`;
	await pi.command(`/loop 1h --fresh ${prompt}`);
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	// While the run waits for its reader, stepping in would strand the reader's completion: refused.
	const launchEnded = () => {
		const f = loopOf(p, id)?.lastRun?.session;
		if (!f || !fs.existsSync(f) || fs.existsSync(finished)) return false;
		return fs.readFileSync(f, "utf8").trim().split("\n").map(l => JSON.parse(l)).some(e =>
			e.type === "message" && e.message?.role === "assistant" && JSON.stringify(e.message.content).includes("WAITING_FOR_READER"));
	};
	await until("the launch turn ended", launchEnded, 240_000);
	await new Promise(r => setTimeout(r, 2_000));
	assert.match(await pi.command(`/loop take ${id}`), /waiting for background work/);
	assert.equal(loopOf(p, id).lastRun.status, "running", "still its own run after the refused takeover");
	await until("the actual reader completes", () => fs.existsSync(finished), 360_000);
	await until("the loop finishes", () => loopOf(p, id)?.lastRun?.status === "done", 120_000);
	const run = loopOf(p, id).lastRun;
	assert.equal(run.result, "READER_CONSUMED", "the launch-only turn must not finish the loop");
	assert.equal(run.findings, false);
	assert.equal(fs.readFileSync(consumed, "utf8").trim(), "READER_RESULT", "one completion, processed once");
	const entries = fs.readFileSync(run.session, "utf8").trim().split("\n").map(l => JSON.parse(l));
	const texts = entries.filter(e => e.type === "message").map(e => JSON.stringify(e.message));
	assert.ok(texts.some(s => s.includes("WAITING_FOR_READER")), "the launching model really ended its first turn");
	assert.equal(entries.filter(e => e.type === "custom_message" && e.customType === "subagent-notify").length, 1,
		"one native completion reached the original loop session");
});

test("a background run may use another extension's synchronous subagent tool", { skip: real, timeout: 300_000 }, async t => {
	const tool = path.join(tmp(t, "pi-loop-e2e-tool-"), "sync-subagent.ts");
	fs.writeFileSync(tool, `import { Type } from "typebox";
export default function (pi: any) {
	pi.registerTool({ name: "subagent", label: "Sync subagent", description: "A synchronous test helper named subagent; returns SYNC_OK.",
		parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "SYNC_OK" }], details: undefined }; } });
}
`);
	const { p, pi } = await bgSession(t, {}, { extensions: [tool] });
	await pi.command(`/loop 1h --fresh Call the subagent tool once with no arguments. ${REPORT(false, "SYNC_OK")}`);
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	await until("the run finishes", () => ["done", "failed"].includes(loopOf(p, id)?.lastRun?.status), 240_000);
	const run = loopOf(p, id).lastRun;
	assert.equal(run.status, "done", JSON.stringify(run));
	assert.equal(run.result, "SYNC_OK");
});

test("a fork loop runs beside the conversation, sees it, and its findings come back as a quiet note", { skip: real, timeout: 420_000 }, async t => {
	const { p, pi } = await bgSession(t);
	await pi.ask("Remember this code word: KUMQUAT. Reply with just ok.");
	const main = await mainFile(pi);
	const before = pi.userMessages().length;
	await pi.command(`/loop 1h --fork Say the code word you were told earlier in this conversation, in capitals. ${REPORT(true, "the code word")} Put the word itself in the summary.`);
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	const run = await until("the run started", () => loopOf(p, id)?.lastRun?.status === "running" && loopOf(p, id).lastRun);
	assert.equal(lockPid(p.cwd), pi.proc.pid, "the run's Pi takes no lock; the session keeps the loops");
	assert.match(await untilNote(pi, "its note"), /KUMQUAT/, "the fork saw the conversation, and its finding came back");
	const done = loopOf(p, id).lastRun;
	assert.equal(done.status, "done"); assert.equal(done.findings, true);
	assert.match(path.basename(path.dirname(done.session)), /-loop-.*--$/, "the run's conversation is kept apart");
	const header = JSON.parse(fs.readFileSync(done.session, "utf8").split("\n")[0]);
	assert.equal(header.parentSession, main, "a fork of the main conversation");
	assert.equal(pi.userMessages().slice(before).filter(m => m.startsWith("[loop")).length, 0, "nothing ran in the main conversation");
	assert.equal(run.mode, "fork");
});

test("a fresh run doesn't see the conversation, and a run with nothing to report stays quiet", { skip: real, timeout: 420_000 }, async t => {
	const { p, pi } = await bgSession(t);
	await pi.ask("Remember this code word: KUMQUAT. Reply with just ok.");
	const main = await mainFile(pi);
	await pi.command(`/loop 1h --fresh If this conversation told you a code word, call loop_report with findings true and the word as summary; if not, call loop_report with findings false and summary "none". Do nothing else.`);
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	const r = await until("the run done", () => ["done", "failed"].includes(loopOf(p, id)?.lastRun?.status) && loopOf(p, id).lastRun);
	assert.equal(r.status, "done");
	assert.equal(r.findings, false, `a fresh run doesn't know the word: ${r.result}`);
	assert.doesNotMatch(fs.readFileSync(r.session, "utf8"), /KUMQUAT/);
	await new Promise(res => setTimeout(res, 3000));
	assert.equal((await notesOf(pi)).length, 0, "no findings, no note");
});

test("a thread loop continues its own conversation each run", { skip: real, timeout: 420_000 }, async t => {
	const { p, pi } = await bgSession(t);
	await pi.command(`/loop 1h --thread Reply with the word tick. ${REPORT(false, "tick")}`);
	const id = p.loops()[0].id;
	for (const n of [1, 2]) {
		await pi.command(`/loop run ${id}`);
		await until(`run ${n} done`, () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun.fire === n);
	}
	const file = loopOf(p, id).lastRun.session;
	const asked = fs.readFileSync(file, "utf8").split("\n").filter(l => l.includes('"role":"user"') && l.includes(`[loop ${id}`));
	assert.equal(asked.length, 2, "both runs in one conversation");
});

test("a self-paced run chooses when it runs next, and stop ends it", { skip: real, timeout: 420_000 }, async t => {
	const { p, pi } = await bgSession(t);
	await pi.command(`/loop auto --fresh Call loop_report with findings false, summary "paced" and next "45m". Do nothing else.`);
	const id = p.loops()[0].id;
	assert.equal(loopOf(p, id).schedule.kind, "auto");
	await pi.command(`/loop run ${id}`);
	const l = await until("the run done", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id));
	const inMin = (l.nextAt - Date.now()) / 60_000;
	assert.ok(inMin > 40 && inMin <= 45.5, `next in ${inMin.toFixed(1)}m`);
	await pi.command(`/loop auto --fresh Call loop_report with findings false, summary "finished" and stop true. Do nothing else.`);
	const id2 = p.loops().find((x: any) => x.id !== id).id;
	await pi.command(`/loop run ${id2}`);
	await until("the loop gone", () => !loopOf(p, id2));
});

test("steer a running background run: your words reach it at its next step", { skip: real, timeout: 420_000 }, async t => {
	const { p, pi } = await bgSession(t);
	const main = await mainFile(pi);
	debugState = () => JSON.stringify(p.loops().map((l: any) => l.lastRun)) + "\nnotes: " + pi.notes().slice(-600);
	await pi.command(`/loop 1h --fresh Run this exact bash command: sleep 20. Then reply with the word ORANGE. ${REPORT(true, "the word you replied with")}`);
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	await until("the run working", () => loopOf(p, id)?.lastRun?.status === "running");
	await new Promise(r => setTimeout(r, 4000));
	const note = await pi.command(`/loop steer ${id} Change of plan from the owner: when the sleep finishes, reply with the word PEAR instead, and report PEAR.`);
	assert.match(note, /sent to/);
	assert.match(await untilNote(pi, "its note"), /PEAR/);
});

test("go into a run, leave it to carry on in the background, go in again and finish it", { skip: real, timeout: 600_000 }, async t => {
	const { p, pi } = await bgSession(t);
	debugState = () => JSON.stringify(p.loops().map((l: any) => l.lastRun)) + "\nnotes: " + pi.notes().slice(-800);
	await pi.ask("Reply with just ok."); // a conversation with something saved to come back to
	const main = await mainFile(pi);
	await pi.command(`/loop 1h --fresh Run this exact bash command: sleep 30. Then reply with the word DONE. ${REPORT(true, "done")}`);
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	await until("the run working", () => loopOf(p, id)?.lastRun?.status === "running");
	const runFile = loopOf(p, id).lastRun.session;
	await pi.command(`/loop take ${id} now`);
	await untilAsync("in the run's conversation", async () => (await mainFile(pi)) === runFile);
	assert.equal(loopOf(p, id).lastRun.status, "away");
	assert.equal(lockPid(p.cwd), pi.proc.pid, "going in keeps the folder's lock");
	await pi.command("/loop leave");
	await untilAsync("back in the main conversation", async () => (await mainFile(pi)) === main);
	await until("carrying on in the background", () => loopOf(p, id)?.lastRun?.status === "running");
	await until("done", () => loopOf(p, id)?.lastRun?.status === "done", 300_000);
	await pi.command(`/loop open ${id}`);
	await untilAsync("in the finished run's conversation", async () => (await mainFile(pi)) === runFile);
	await pi.command("/loop done");
	await untilAsync("back again", async () => (await mainFile(pi)) === main);
	assert.equal(loopOf(p, id).lastRun.status, "done");
});

test("a /new keeps the folder's lock and the runs going; their findings land in the new conversation", { skip: real, timeout: 420_000 }, async t => {
	const { p, pi } = await bgSession(t);
	await pi.command(`/loop 1h --fresh Run this exact bash command: sleep 15. ${REPORT(true, "slept")}`);
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	await until("the run working", () => loopOf(p, id)?.lastRun?.status === "running");
	const r = await pi.send({ type: "new_session" });
	assert.equal(r.success, true);
	assert.equal(lockPid(p.cwd), pi.proc.pid);
	await untilNote(pi, "its note in the new conversation");
});

test("background runs wait for a slot when loop.maxBackground is reached", { skip: real, timeout: 420_000 }, async t => {
	const sleeper = (id: string) => ({ ...due(id), run: "fresh", prompt: `Run this exact bash command: sleep 12. ${REPORT(false, id)}` });
	const { p } = await bgSession(t, { loops: [sleeper("one"), sleeper("two")] }, { loop: { maxBackground: 1 } });
	await until("both done", () => p.loops().every((l: any) => l.lastRun?.status === "done"), 360_000);
	const [a, b] = ["one", "two"].map(id => loopOf(p, id).lastRun).sort((x: any, y: any) => x.startedAt - y.startedAt);
	assert.ok(b.startedAt >= a.endedAt, "the second started only after the first finished");
});

test("/loop cancel stops a running run; it is recorded as cancelled", { skip: real, timeout: 300_000 }, async t => {
	const { p, pi } = await bgSession(t);
	await pi.command(`/loop 1h --fresh Run this exact bash command: sleep 60. ${REPORT(true, "slept")}`);
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	await until("the run working", () => loopOf(p, id)?.lastRun?.status === "running");
	assert.match(await pi.command(`/loop cancel ${id}`), /stopped/);
	await until("cancelled", () => loopOf(p, id)?.lastRun?.status === "cancelled", 30_000);
	assert.doesNotMatch(await pi.command("/loop list"), /running in background/);
});

test("a crashed Pi's runs are marked interrupted by the next session and not resumed", { skip: real, timeout: 300_000 }, async t => {
	const { p, pi } = await bgSession(t);
	await pi.command(`/loop 1h --fresh Run this exact bash command: sleep 60. ${REPORT(true, "slept")}`);
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	await until("the run working", () => loopOf(p, id)?.lastRun?.status === "running");
	pi.proc.kill("SIGKILL");
	await until("Pi gone", () => pi.proc.exitCode !== null || pi.proc.signalCode !== null, 30_000);
	const next = new Pi(t, p, {}, { sessionDir: tmp(t, "pi-loop-e2e-sessions-") });
	await next.ready();
	const r = await until("interrupted", () => loopOf(p, id)?.lastRun?.status === "interrupted" && loopOf(p, id).lastRun, 60_000);
	assert.equal(r.unread, true);
	await new Promise(res => setTimeout(res, 5000));
	assert.equal(loopOf(p, id).lastRun.status, "interrupted", "not resumed by itself");
});

test("quitting Pi interrupts its runs; the next session says so and doesn't resume them", { skip: real, timeout: 420_000 }, async t => {
	const { p, pi } = await bgSession(t);
	await pi.command(`/loop 1h --fresh Run this exact bash command: sleep 60. ${REPORT(true, "slept")}`);
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	await until("the run working", () => loopOf(p, id)?.lastRun?.status === "running");
	pi.stop();
	await until("Pi gone", () => pi.proc.exitCode !== null || pi.proc.signalCode !== null, 30_000);
	const next = new Pi(t, p, {}, { sessionDir: tmp(t, "pi-loop-e2e-sessions-") });
	await next.ready();
	const r = await until("interrupted", () => loopOf(p, id)?.lastRun?.status === "interrupted" && loopOf(p, id).lastRun, 60_000);
	assert.equal(r.unread, true);
});

test("ad hoc loops end after 7 days by default, or when they say", { timeout: 150_000 }, async t => {
	const p = project(t);
	const pi = new Pi(t, p);
	await pi.ready();
	await pi.command("/loop 1h week-long");
	const week = p.loops()[0];
	const days = (week.expiresAt - week.createdAt) / 86_400_000;
	assert.ok(Math.abs(days - 7) < 0.01, `ends in ${days} days`);
	await pi.command("/loop 1h --for 1m short-lived");
	assert.ok(p.loops().some((l: any) => l.prompt === "short-lived"));
	await until("the short one ended", () => !p.loops().some((l: any) => l.prompt === "short-lived"), 120_000);
	assert.ok(p.loops().some((l: any) => l.prompt === "week-long"), "the other stays");
	assert.match(fs.readFileSync(path.join(p.cwd, ".pi/loops.log.jsonl"), "utf8"), /"action":"expired"/);
});


test("the loops view in Pi's terminal UI: cards for each loop, a run's transcript, back and closed with Esc", { timeout: 120_000 }, async t => {
	const p = project(t);
	// A finished background run and its conversation, as a real run leaves them.
	const sessions = tmp(t, "pi-loop-e2e-tui-");
	const runFile = path.join(sessions, "2026-10-06T00-00-00-000Z_01a00000-0000-7000-8000-00000000abcd.jsonl");
	fs.writeFileSync(runFile, [
		{ type: "session", version: 3, id: "01a00000-0000-7000-8000-00000000abcd", timestamp: "2026-10-06T00:00:00.000Z", cwd: p.cwd },
		{ type: "message", id: "a1", parentId: null, timestamp: "2026-10-06T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "[loop deploy-watch · every 1h · fire #3 · background fresh] check the deploy" }], timestamp: 1 } },
		{ type: "message", id: "a2", parentId: "a1", timestamp: "2026-10-06T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Deploy 812 is healthy; nothing new." }], timestamp: 2 } },
	].map(e => JSON.stringify(e)).join("\n") + "\n");
	fs.writeFileSync(path.join(p.cwd, ".pi/loops.json"), JSON.stringify([
		{ ...due("deploy-watch"), nextAt: Date.now() + 3_600_000, run: "fresh", fires: 3,
			lastRun: { fire: 3, mode: "fresh", status: "done", startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000, session: runFile, result: "Deploy 812 is healthy; nothing new.", findings: false } },
		{ ...due("nightly"), nextAt: Date.now() + 7_200_000, paused: true },
	]));
	const term = spawn("python3", [path.join(PACKAGE, "tests/terminal.py"), PI, "--no-session", "-e", PACKAGE], { cwd: p.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: p.agent, TERM: "xterm-256color" } });
	let screen = "";
	term.stdout.setEncoding("utf8");
	term.stdout.on("data", (d: string) => { screen += d; });
	t.after(() => term.kill("SIGTERM"));
	const plain = () => screen.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]/g, "");
	const seen = async (re: RegExp, what: string, ms = 30_000) => {
		const end = Date.now() + ms;
		while (!re.test(plain())) { if (Date.now() > end) throw new Error(`no ${what} on screen; last: ${plain().slice(-1500)}`); await new Promise(r => setTimeout(r, 200)); }
	};
	const type = async (s: string) => { term.stdin.write(s); await new Promise(r => setTimeout(r, 400)); };
	await seen(/loops: /, "the status line", 60_000);
	await type("/loop");
	await type("\r");
	await seen(/loops · /, "the loops view");
	await seen(/deploy-watch/, "the deploy-watch card");
	await seen(/nightly\s+paused/, "the paused card");
	await seen(/last #3 done: Deploy 812 is healthy/, "its last run");
	const before = screen.length;
	await type("\r");
	await seen(/loop deploy-watch/, "the watch view");
	assert.match(plain().slice(-4000), /Deploy 812 is healthy; nothing new\./, "the run's conversation");
	assert.ok(screen.length > before);
	await type("\x1b");
	await seen(/Enter watch · t go in · r run now/, "the list again");
	await type("\x1b");
	await new Promise(r => setTimeout(r, 800));
	await type("hello");
	await seen(/hello/, "the editor taking text again");
});


// The switch and lock mechanics need no model: on the closed provider a run's turn fails at once and the run settles.
async function closedSession(t: any, args: string[] = []) {
	const p = project(t);
	const sessions = tmp(t, "pi-loop-e2e-sessions-");
	const pi = new Pi(t, p, {}, { sessionDir: sessions, args });
	await pi.ready();
	await new Promise(r => setTimeout(r, 1500)); // the folder's lock is claimed
	return { p, pi };
}
const listOf = async (pi: Pi) => pi.command("/loop list");

test("leaving a run with Pi's own /new counts as /loop leave: the run carries on, and in-conversation loops run again", { timeout: 120_000 }, async t => {
	const { p, pi } = await closedSession(t);
	await pi.ask("hello", 60_000); // the conversation has something saved to come back to
	await pi.command("/loop 1h --fresh say hi");
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	const run = await until("the run done", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 60_000);
	await pi.command(`/loop open ${id}`);
	await untilAsync("in the run", async () => (await mainFile(pi)) === run.session);
	assert.equal(loopOf(p, id).lastRun.status, "away");
	assert.equal((await pi.send({ type: "new_session" })).success, true);
	await until("the run carried on and settled", () => loopOf(p, id)?.lastRun?.status === "done", 60_000);
	assert.doesNotMatch(await listOf(pi), /you are in/, "not in the run any more");
	await pi.command("/loop 1h ping");
	const ping = p.loops().find((l: any) => l.prompt === "ping").id;
	await pi.command(`/loop run ${ping}`);
	await pi.waitForUser(new RegExp(`^\\[loop ${ping} ·`), 30_000);
});

test("a run that finishes during a session switch is recorded, not lost", { timeout: 120_000 }, async t => {
	const { p, pi } = await closedSession(t);
	await pi.command("/loop 1h --fresh say hi");
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	await pi.send({ type: "new_session" }); // Pi rebuilds the extension while the run starts and ends
	const r = await until("the run recorded", () => ["done", "failed"].includes(loopOf(p, id)?.lastRun?.status) && loopOf(p, id).lastRun, 60_000);
	assert.ok(r.endedAt);
	await until("no run left going", async () => !/running in background/.test(await listOf(pi)) || undefined, 20_000).catch(async () => assert.fail(await listOf(pi)));
	await pi.command(`/loop run ${id}`);
	await until("it runs again", () => loopOf(p, id)?.lastRun?.fire === r.fire + 1 && loopOf(p, id).lastRun.status === "done", 60_000);
});

test("a run that asks for a dialog: declined, and it says it needs you; a command prompt doesn't hold its slot", { timeout: 120_000 }, async t => {
	const ext = path.join(tmp(t, "pi-loop-e2e-ext-"), "dialog.ts");
	fs.writeFileSync(ext, `export default function (pi: any) {
	pi.registerCommand("ask-dialog", { description: "asks", handler: async (_a: string, ctx: any) => { const ok = await ctx.ui.confirm("Deploy now?", "e2e"); ctx.ui.notify("answered " + ok); } });
}\n`);
	const { p, pi } = await closedSession(t, ["-e", ext]);
	await pi.command("/loop 1h --fresh /ask-dialog");
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	const r = await until("the run done", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 60_000);
	assert.match(r.needsYou ?? "", /confirm/, JSON.stringify(r));
	assert.equal(r.unread, true);
	assert.match(await untilNote(pi, "its note", 30_000), /needs you/);
});


test("opening a finished run to read it and leaving with /new starts nothing in it", { timeout: 120_000 }, async t => {
	const { p, pi } = await closedSession(t);
	await pi.ask("hello", 60_000);
	await pi.command("/loop 1h --fresh say hi");
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	const run = await until("the run done", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 60_000);
	const asked = () => fs.readFileSync(run.session, "utf8").split("\n").filter(l => l.includes('"role":"user"')).length;
	const before = asked();
	await pi.command(`/loop open ${id}`);
	await untilAsync("in the run", async () => (await mainFile(pi)) === run.session);
	assert.equal((await pi.send({ type: "new_session" })).success, true);
	await until("recorded as done again", () => loopOf(p, id)?.lastRun?.status === "done", 30_000);
	await new Promise(r => setTimeout(r, 4000));
	assert.equal(asked(), before, "no new turn in the run you only read");
	assert.doesNotMatch(await listOf(pi), /running in background/);
});

test("a skill as a background loop's prompt keeps the loop's header (and the run inherits -a, trusting the project's skills)", { timeout: 120_000 }, async t => {
	const { p, pi } = await closedSession(t, ["-a"]);
	fs.mkdirSync(path.join(p.cwd, ".pi/skills/echo"), { recursive: true });
	fs.writeFileSync(path.join(p.cwd, ".pi/skills/echo/SKILL.md"), "---\nname: echo\ndescription: Say what you are asked to say. Use for e2e tests.\n---\n\nSay the words you are given.\n");
	await pi.send({ type: "prompt", message: "/reload" });
	await new Promise(r => setTimeout(r, 2000));
	await pi.command("/loop 1h --fresh /skill:echo hello");
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	const run = await until("the run done", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 60_000);
	const user = fs.readFileSync(run.session, "utf8").split("\n").find(l => l.includes('"role":"user"')) ?? "";
	assert.match(user, /Say the words you are given/, "the skill was expanded");
	assert.match(user, new RegExp(`\\[loop ${id} ·`), "with the loop's header");
	assert.match(user, /loop_report/, "and the report hint");
});


test("a background run's conversations are filed under its loop's folder (--<folder>-loop-<id>--)", { timeout: 120_000 }, async t => {
	const { p, pi } = await closedSession(t);
	fs.mkdirSync(path.join(p.cwd, "svc/.pi"), { recursive: true });
	fs.writeFileSync(path.join(p.cwd, "svc/.pi/loop.json"), JSON.stringify({ loops: [{ id: "svc-check", prompt: "say hi", every: "1h", run: "fresh" }] }));
	await until("the declared loop", () => loopOf(p, "svc-check"), 30_000);
	await pi.command("/loop run svc-check");
	const r = await until("the run done", () => loopOf(p, "svc-check")?.lastRun?.status === "done" && loopOf(p, "svc-check").lastRun, 60_000);
	assert.match(path.basename(path.dirname(r.session)), /-svc-loop-svc-check--$/, r.session);
});


test("a thread loop with its own folder carries on from its 0.4.0 folder (--<cwd>-loop-<id>--), moved once", { timeout: 180_000 }, async t => {
	const { p, pi } = await closedSession(t);
	fs.mkdirSync(path.join(p.cwd, "op/.pi"), { recursive: true });
	fs.writeFileSync(path.join(p.cwd, "op/.pi/loop.json"), JSON.stringify({ loops: [{ id: "op-check", prompt: "say hi", every: "1h", run: "thread" }] }));
	await until("the declared loop", () => loopOf(p, "op-check"), 30_000);
	await pi.command("/loop run op-check");
	const first = await until("the first run done", () => loopOf(p, "op-check")?.lastRun?.status === "done" && loopOf(p, "op-check").lastRun, 60_000);
	const now = path.dirname(first.session);
	// As 0.4.0 left it: the thread under the session's cwd name.
	const legacy = path.join(path.dirname(now), path.basename(now).replace(/-op-loop-op-check--$/, "-loop-op-check--"));
	assert.notEqual(legacy, now);
	fs.renameSync(now, legacy);
	await pi.command("/loop run op-check");
	const second = await until("the second run done", () => loopOf(p, "op-check")?.lastRun?.fire === first.fire + 1 && loopOf(p, "op-check").lastRun.status === "done" && loopOf(p, "op-check").lastRun, 60_000);
	assert.equal(second.session, first.session, "the same thread, in the loop's own folder");
	assert.ok(!fs.existsSync(legacy), "the old folder was moved, not copied");
});

test("a command run in the background whose own turn starts a few seconds after it is handled isn't cut short", { timeout: 120_000 }, async t => {
	const ext = path.join(tmp(t, "pi-loop-e2e-ext-"), "late.ts");
	fs.writeFileSync(ext, `export default function (pi: any) {
	pi.registerCommand("late-turn", { description: "starts a turn later", handler: async () => { setTimeout(() => pi.sendUserMessage("late turn marker"), 2500); } });
}\n`);
	const { p, pi } = await closedSession(t, ["-e", ext]);
	await pi.command("/loop 1h --fresh /late-turn");
	const id = p.loops()[0].id;
	await pi.command(`/loop run ${id}`);
	const r = await until("the run done", () => loopOf(p, id)?.lastRun?.status === "done" && loopOf(p, id).lastRun, 60_000);
	assert.ok(r.session && fs.existsSync(r.session), JSON.stringify(r));
	assert.match(fs.readFileSync(r.session, "utf8"), /late turn marker/, "its turn ran before the run was stopped");
});


test("a background run of an adopted sibling folder's loop runs there: its prompt, AGENTS.md and model, and pi-loop comes along for loop_report", { timeout: 300_000, skip: real }, async t => {
	const p = project(t, { fireworks: true });
	const sib = tmp(t, "pi-loop-e2e-sib-");
	const role = path.join(sib, "role");
	fs.mkdirSync(path.join(sib, ".pi"), { recursive: true });
	fs.mkdirSync(path.join(role, ".pi/prompts"), { recursive: true });
	fs.writeFileSync(path.join(role, "AGENTS.md"), "# Role\n\nThe password of this folder is MANGO-17.\n");
	fs.writeFileSync(path.join(role, ".pi/prompts/hello.md"), "---\ndescription: say the password\n---\nSay this folder's password (from your AGENTS.md instructions). Then call loop_report once with findings false and the password as the summary.\n");
	fs.writeFileSync(path.join(role, ".pi/loop.json"), JSON.stringify({ loops: [{ id: "sib-check", prompt: "/hello", every: "1h", run: "fresh", model: `${PROVIDER}/${MODEL}:low` }] }));
	// As on a box: pi-loop is the project's package, and the project adopts the sibling folder.
	fs.writeFileSync(path.join(p.cwd, ".pi/settings.json"), JSON.stringify({ packages: [PACKAGE], loop: { folders: [path.relative(p.cwd, sib)] } }));
	const sessions = tmp(t, "pi-loop-e2e-sessions-");
	// As on a box: trust saved for the folders (a run can't answer Pi's trust question), no -a.
	fs.writeFileSync(path.join(p.agent, "trust.json"), JSON.stringify({ [fs.realpathSync(p.cwd)]: true, [fs.realpathSync(sib)]: true }));
	const pi = new Pi(t, p, {}, { sessionDir: sessions, asPackage: true });
	await pi.ready();
	await until("the sibling's loop", () => fs.existsSync(path.join(p.cwd, ".pi/loops.json")) && loopOf(p, "sib-check"), 30_000);
	assert.equal(loopOf(p, "sib-check").model, `${PROVIDER}/${MODEL}:low`);
	await pi.command("/loop run sib-check");
	const r = await until("the run done", () => ["done", "failed"].includes(loopOf(p, "sib-check")?.lastRun?.status) && loopOf(p, "sib-check").lastRun, 240_000);
	assert.equal(r.status, "done", JSON.stringify(r));
	assert.equal(r.findings, false, `loop_report reached the run (pi-loop loaded there): ${JSON.stringify(r)}`);
	assert.match(r.result, /MANGO-17/, "the role folder's AGENTS.md");
	const lines = fs.readFileSync(r.session, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
	assert.equal(lines[0].cwd, fs.realpathSync(role), "the run's cwd is the loop's folder");
	assert.match(path.basename(path.dirname(r.session)), /-role-loop-sib-check--$/);
	assert.ok(lines.some(e => e.type === "thinking_level_change" && e.thinkingLevel === "low"), "the loop's thinking level, not the session's (off)");
	assert.ok(lines.some(e => e.type === "message" && e.message?.role === "assistant" && e.message.model === MODEL), "the loop's model");
	// Your words to the finished run start it again there: same folder, its model and thinking, loop_report.
	await pi.command("/loop steer sib-check Say the password once more, then call loop_report once with findings false and the password as the summary.");
	const again = await until("the resumed run done", () => { const x = loopOf(p, "sib-check")?.lastRun; return x && x.status === "done" && x.endedAt > r.endedAt && x; }, 240_000);
	assert.equal(again.findings, false, `loop_report reached the resumed run: ${JSON.stringify(again)}`);
	const after = fs.readFileSync(again.session, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
	assert.ok(!after.some(e => e.type === "thinking_level_change" && e.thinkingLevel !== "low"), "still the loop's thinking level");
	assert.equal(after.filter(e => e.type === "message" && e.message?.role === "assistant").at(-1)?.message.model, MODEL);
});

test("a sibling folder's loops are run only when the project adopts it (loop.folders)", { timeout: 60_000 }, async t => {
	const { p, pi } = await closedSession(t);
	const sib = tmp(t, "pi-loop-e2e-sib-");
	fs.mkdirSync(path.join(sib, ".pi"), { recursive: true });
	fs.mkdirSync(path.join(sib, "role/.pi"), { recursive: true });
	fs.writeFileSync(path.join(sib, "role/.pi/loop.json"), JSON.stringify({ loops: [{ id: "sib-only", prompt: "hi", every: "1h", run: "fresh" },
		{ id: "sib-here", prompt: "hi", every: "1h" }] }));
	await pi.command("/reload");
	await new Promise(r => setTimeout(r, 2000));
	assert.equal(fs.existsSync(path.join(p.cwd, ".pi/loops.json")) ? loopOf(p, "sib-only") : undefined, undefined, "not adopted: not run");
	fs.writeFileSync(path.join(p.cwd, ".pi/settings.json"), JSON.stringify({ loop: { folders: [path.relative(p.cwd, sib)] } }));
	await pi.command("/reload");
	const l = await until("adopted: its loop", () => fs.existsSync(path.join(p.cwd, ".pi/loops.json")) && loopOf(p, "sib-only"), 30_000);
	assert.equal(l.dir, path.relative(fs.realpathSync(p.cwd), fs.realpathSync(path.join(sib, "role"))));
	assert.equal(loopOf(p, "sib-here"), undefined, "a loop in an adopted folder runs only in the background");
	// A settings file that can't be read keeps the adopted loops (and their state) rather than dropping them.
	fs.writeFileSync(path.join(p.cwd, ".pi/settings.json"), "{ not json");
	await pi.command("/reload");
	await new Promise(r => setTimeout(r, 2000));
	assert.ok(loopOf(p, "sib-only"), "kept while the setting can't be read");
	// Only a folder beside the project counts: its role folder named directly (one level down) doesn't.
	fs.writeFileSync(path.join(p.cwd, ".pi/settings.json"), JSON.stringify({ loop: { folders: [path.join(path.relative(p.cwd, sib), "role")] } }));
	const from = pi.lines.length;
	await pi.command("/reload");
	await until("the refusal", () => /not a folder beside this project/.test(pi.notes(from)) || undefined, 20_000);
});


test("going into a run that works in another folder is refused, with how to watch and steer it", { timeout: 120_000 }, async t => {
	const { p, pi } = await closedSession(t);
	await pi.ask("hello", 60_000);
	const home = await mainFile(pi);
	fs.mkdirSync(path.join(p.cwd, "op/.pi"), { recursive: true });
	fs.writeFileSync(path.join(p.cwd, "op/.pi/loop.json"), JSON.stringify({ loops: [{ id: "op-run", prompt: "say hi", every: "1h", run: "fresh" }] }));
	await until("the declared loop", () => loopOf(p, "op-run"), 30_000);
	await pi.command("/loop run op-run");
	const run = await until("the run done", () => loopOf(p, "op-run")?.lastRun?.status === "done" && loopOf(p, "op-run").lastRun, 60_000);
	assert.equal(JSON.parse(fs.readFileSync(run.session, "utf8").split("\n")[0]).cwd, fs.realpathSync(path.join(p.cwd, "op")));
	// Pi would open it in its folder, moving this session (lock, settings, data class) there: refused, with the way.
	assert.match(await pi.command("/loop open op-run"), /works in .*op, not this folder.*\/loop steer op-run/s);
	assert.equal(await mainFile(pi), home, "still here");
	assert.ok(!fs.existsSync(path.join(p.cwd, "op/.pi/loops.json")), "nothing of this session's written in the run's folder");
});


test("a thread whose conversation was made in another folder carries on from a copy made in its own", { timeout: 180_000 }, async t => {
	const { p, pi } = await closedSession(t);
	fs.mkdirSync(path.join(p.cwd, "op/.pi"), { recursive: true });
	fs.writeFileSync(path.join(p.cwd, "op/.pi/loop.json"), JSON.stringify({ loops: [{ id: "op-thread", prompt: "say hi", every: "1h", run: "thread" }] }));
	await until("the declared loop", () => loopOf(p, "op-thread"), 30_000);
	await pi.command("/loop run op-thread");
	const first = await until("the first run done", () => loopOf(p, "op-thread")?.lastRun?.status === "done" && loopOf(p, "op-thread").lastRun, 60_000);
	// As 0.4 left it: the thread's conversation made in the project's folder.
	const lines = fs.readFileSync(first.session, "utf8").split("\n");
	lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), cwd: fs.realpathSync(p.cwd) });
	fs.writeFileSync(first.session, lines.join("\n"));
	await pi.command("/loop run op-thread");
	const second = await until("the second run done", () => { const x = loopOf(p, "op-thread")?.lastRun; return x?.fire === first.fire + 1 && x.status === "done" && x; }, 60_000);
	assert.notEqual(second.session, first.session, "a copy");
	const copy = fs.readFileSync(second.session, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
	assert.equal(copy[0].cwd, fs.realpathSync(path.join(p.cwd, "op")), "made in its folder");
	assert.equal(copy.filter(e => e.type === "message" && e.message?.role === "user").length, 2, "with the earlier run's conversation");
	await pi.command("/loop run op-thread");
	const third = await until("the third run done", () => { const x = loopOf(p, "op-thread")?.lastRun; return x?.fire === first.fire + 2 && x.status === "done" && x; }, 60_000);
	assert.equal(third.session, second.session, "and continues the copy from then on");
});

test("a folder whose loops this session runs is held: a session opened in it is read-only, also after /new", { timeout: 180_000 }, async t => {
	const { p, pi } = await closedSession(t);
	fs.mkdirSync(path.join(p.cwd, "op/.pi"), { recursive: true });
	fs.writeFileSync(path.join(p.cwd, "op/.pi/loop.json"), JSON.stringify({ loops: [{ id: "op-held", prompt: "say hi", every: "1h", run: "fresh" }] }));
	await until("the declared loop", () => loopOf(p, "op-held"), 30_000);
	// As an old role session left it: its own loop list in the folder.
	const own = JSON.stringify([{ id: "role-own", prompt: "hi", schedule: { kind: "every", ms: 3_600_000 }, catchUp: "latest", paused: false, createdAt: 1, nextAt: 1, fires: 0 }]);
	fs.writeFileSync(path.join(p.cwd, "op/.pi/loops.json"), own);
	const opened = async () => {
		const there = new Pi(t, { cwd: path.join(p.cwd, "op"), agent: p.agent }, {}, { sessionDir: tmp(t, "pi-loop-e2e-sessions-") });
		await there.ready();
		assert.match(await there.command("/loop run role-own"), /owned by pid \d+/, "its loops can't be run there");
		await new Promise(r => setTimeout(r, 3000));
		assert.equal(fs.readFileSync(path.join(p.cwd, "op/.pi/loops.json"), "utf8"), own, "nor changed");
		there.stop();
	};
	await opened();
	assert.equal((await pi.send({ type: "new_session" })).success, true); // Pi rebuilds the extension; the locks stay
	await new Promise(r => setTimeout(r, 2000));
	await opened();
	await pi.command("/loop run op-held");
	await until("still run by the session that holds it", () => loopOf(p, "op-held")?.lastRun?.status === "done", 60_000);
});

test("a run in another folder takes the machine's own pi-loop when it is 0.5 or later, and refuses an older one", { timeout: 180_000 }, async t => {
	for (const older of [false, true]) {
		const p = project(t);
		fs.mkdirSync(path.join(p.cwd, "op/.pi"), { recursive: true });
		fs.writeFileSync(path.join(p.cwd, "op/.pi/loop.json"), JSON.stringify({ loops: [{ id: "op-own", prompt: "say hi", every: "1h", run: "fresh" }] }));
		// As on a box: the project pins pi-loop; the machine's own settings list one too.
		fs.writeFileSync(path.join(p.cwd, ".pi/settings.json"), JSON.stringify({ packages: [PACKAGE] }));
		const settings = JSON.parse(fs.readFileSync(path.join(p.agent, "settings.json"), "utf8"));
		if (older) {
			// A real 0.2.1 checkout where Pi keeps the machine's git packages (listed, its extension not loaded here).
			const dir = path.join(p.agent, "git/github.com/recursive-systems/pi-loop");
			execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", "v0.2.1", "https://github.com/recursive-systems/pi-loop", dir]);
			settings.packages = [{ source: "git:github.com/recursive-systems/pi-loop@v0.2.1", extensions: [], skills: [] }];
		} else settings.packages = [PACKAGE];
		fs.writeFileSync(path.join(p.agent, "settings.json"), JSON.stringify(settings));
		fs.writeFileSync(path.join(p.agent, "trust.json"), JSON.stringify({ [fs.realpathSync(p.cwd)]: true }));
		const pi = new Pi(t, p, {}, { sessionDir: tmp(t, "pi-loop-e2e-sessions-"), asPackage: true });
		await pi.ready();
		await until("the declared loop", () => fs.existsSync(path.join(p.cwd, ".pi/loops.json")) && loopOf(p, "op-own"), 30_000);
		await pi.command("/loop run op-own");
		const r = await until("the run over", () => ["done", "failed"].includes(loopOf(p, "op-own")?.lastRun?.status) && loopOf(p, "op-own").lastRun, 60_000);
		if (older) {
			assert.equal(r.status, "failed");
			assert.match(r.result, /\(0\.2\.1\) is older than 0\.5/);
		} else {
			assert.equal(r.status, "done", JSON.stringify(r));
			const system = fs.readFileSync(r.session, "utf8").split("\n").map(l => { try { return JSON.parse(l); } catch { return {}; } }).find(e => e.message?.role === "system");
			assert.match(JSON.stringify(system), /loop_report/, "the machine's own pi-loop gave the run loop_report");
		}
		pi.stop();
	}
});

test("asked to make an in-conversation loop in an adopted folder, loop_manage refuses", { timeout: 300_000, skip: real }, async t => {
	const p = project(t, { fireworks: true });
	const sib = tmp(t, "pi-loop-e2e-sib-");
	fs.mkdirSync(path.join(sib, ".pi"), { recursive: true });
	fs.mkdirSync(path.join(sib, "role"), { recursive: true });
	const rel = path.join(path.relative(p.cwd, sib), "role");
	fs.writeFileSync(path.join(p.cwd, ".pi/settings.json"), JSON.stringify({ loop: { folders: [path.relative(p.cwd, sib)] } }));
	const pi = new Pi(t, p, {}, { sessionDir: tmp(t, "pi-loop-e2e-sessions-") });
	await pi.ready();
	await new Promise(r => setTimeout(r, 1500));
	await pi.ask(`Call loop_manage once with action "create", id "x-here", prompt "hi", every "1h", dir "${rel}" and no run. Then tell me exactly what it replied.`);
	const results = pi.lines.filter(l => l.type === "tool_execution_end" && l.toolName === "loop_manage").map(l => JSON.stringify(l.result));
	assert.ok(results.length, "the model called it");
	assert.match(results.join("\n"), /adopted folder runs in the background/);
	assert.equal(fs.existsSync(path.join(p.cwd, ".pi/loops.json")) ? loopOf(p, "x-here") : undefined, undefined);
});

// ------------------------------------------------------------ what a run leaves behind --
// Pi keeps a run's conversation, cost and the owner's words in the run's session; pi-loop adds only what it alone
// knows: why the run happened (a custom entry in that session, a `fired` line in the gate log) and, at a heartbeat,
// what the gate would have said.

const logOf = (cwd: string) => { try { return fs.readFileSync(path.join(cwd, ".pi/loops.log.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)); } catch { return []; } };
const entriesOf = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));

test("a background run's session records why it ran and is named after it; the gate log links to it", { timeout: 120_000 }, async t => {
	const { p, pi } = await closedSession(t);
	fs.writeFileSync(path.join(p.cwd, ".pi/loop.json"), JSON.stringify({ loops: [{ id: "tidy", prompt: "say hi", every: "1h", run: "fresh" }] }));
	await until("the declared loop", () => loopOf(p, "tidy"), 30_000);
	await pi.command("/loop run tidy");
	const r = await until("the run done", () => loopOf(p, "tidy")?.lastRun?.status === "done" && loopOf(p, "tidy").lastRun, 60_000);
	const entries = entriesOf(r.session);
	const marks = entries.filter(e => e.type === "custom" && e.customType === "pi-loop.run");
	assert.deepEqual(marks.map(e => e.data), [{ loop: "tidy", fire: 1, mode: "fresh", by: "manual" }]);
	assert.ok(entries.some(e => e.type === "session_info" && e.name === "loop tidy #1"), "named after the run");
	const fired = logOf(p.cwd).filter(e => e.action === "fired");
	assert.deepEqual(fired.map(e => [e.id, e.fire, e.by, e.mode, e.session]), [["tidy", 1, "manual", "fresh", r.session]]);
});

test("at a heartbeat the model wakes without the gate, and the gate's would-be answer is logged as a test", { timeout: 120_000 }, async t => {
	// The gate leaves a mark only when it is not a test, so a test can't change what it decides next time.
	const gate = '#!/bin/sh\n[ "$LOOP_TEST" = 1 ] || touch "$LOOP_STATE_DIR/real"\necho "{\\"action\\":\\"skip\\",\\"reason\\":\\"all quiet (test=$LOOP_TEST)\\"}"\n';
	const p = project(t, {
		loops: [due("disk", { gate: { command: ".pi/gates/disk", timeoutMs: 10_000, onError: "wake", maxSleepMs: 60_000 }, lastWokeAt: Date.now() - 3_600_000 })],
		gates: { disk: gate },
	});
	const sessions = tmp(t, "pi-loop-e2e-sessions-");
	const pi = new Pi(t, p, {}, { sessionDir: sessions });
	await pi.ready();
	const msg = await pi.waitForUser(/^\[loop disk /);
	assert.match(msg, /gate: max sleep 1m reached; gate not consulted/);
	const shadow = await until("the shadow line", () => logOf(p.cwd).find(e => e.action === "shadow"), 30_000);
	assert.deepEqual([shadow.id, shadow.of, shadow.fire, shadow.decision, shadow.reason], ["disk", "heartbeat", 1, "skip", "all quiet (test=1)"]);
	assert.ok(!fs.existsSync(path.join(p.cwd, ".pi/loop-state/disk/real")), "the gate ran as a test only");
	const fired = logOf(p.cwd).find(e => e.action === "fired");
	assert.deepEqual([fired.fire, fired.by, fired.mode], [1, "heartbeat", "conversation"]);
	// In this conversation the record goes into its own session.
	const file = await mainFile(pi);
	const mark = await until("the session's record", () => fs.existsSync(file) && entriesOf(file).find(e => e.type === "custom" && e.customType === "pi-loop.run"), 30_000);
	assert.deepEqual(mark.data, { loop: "disk", fire: 1, mode: "conversation", by: "heartbeat", gate: { reason: "max sleep 1m reached; gate not consulted" } });
	assert.equal(fired.session, file);
});

test("a gate's wake is recorded as by the gate, with its reason", { timeout: 120_000 }, async t => {
	const { p, pi } = await closedSession(t);
	fs.mkdirSync(path.join(p.cwd, ".pi/gates"), { recursive: true });
	fs.writeFileSync(path.join(p.cwd, ".pi/gates/q"), '#!/bin/sh\necho \'{"action":"wake","reason":"queue grew"}\'\n', { mode: 0o755 });
	fs.writeFileSync(path.join(p.cwd, ".pi/loop.json"), JSON.stringify({ loops: [{ id: "q", prompt: "say hi", every: "1m", gate: ".pi/gates/q", run: "fresh" }] }));
	const r = await until("the run done", () => loopOf(p, "q")?.lastRun?.status === "done" && loopOf(p, "q").lastRun, 120_000);
	const mark = entriesOf(r.session).find(e => e.type === "custom" && e.customType === "pi-loop.run");
	assert.deepEqual(mark.data, { loop: "q", fire: r.fire, mode: "fresh", by: "gate", gate: { reason: "queue grew" } });
	const log = logOf(p.cwd);
	const i = log.findIndex(e => e.action === "fired" && e.fire === r.fire);
	assert.ok(i > 0 && log[i - 1].action === "wake" && log[i - 1].reason === "queue grew", JSON.stringify(log));
});
