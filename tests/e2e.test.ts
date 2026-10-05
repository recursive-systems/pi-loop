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
// The waiting tests need a session that stays busy. For those the provider's endpoint is a
// local socket that accepts the model request and never answers, so Pi is genuinely mid-run
// (waiting on its model) until the test aborts it over RPC. It stands in for a slow model,
// not for anything this extension talks to.
//
// One test goes all the way to a real model: set FIREWORKS_API_KEY (or FIREWORKS_API_KEY_FILE,
// a file holding it) and it runs a woken loop through Fireworks (PI_LOOP_E2E_MODEL to pick the
// model). Without a key it is skipped, and says so.
//
// Needs `pi` on PATH (PI_BIN to override). Run: npm test
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The repository as a Pi package: the extension and its skill, as `pi install` would load them.
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const PI = process.env.PI_BIN || "pi";
const TICK = 15_000;
const MODEL = process.env.PI_LOOP_E2E_MODEL || "accounts/fireworks/models/deepseek-v4p1-flash";

function fireworksKey(): string | undefined {
	if (process.env.FIREWORKS_API_KEY) return process.env.FIREWORKS_API_KEY;
	const file = process.env.FIREWORKS_API_KEY_FILE;
	if (!file) return undefined;
	try { return fs.readFileSync(file.replace(/^~(?=\/)/, process.env.HOME ?? "~"), "utf8").trim() || undefined; } catch { return undefined; }
}

for (const k of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_SESSION_ID", "PI_SESSION_FILE"]) delete process.env[k];

function tmp(t: any, prefix: string) {
	const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A model endpoint that takes the request and never answers: the session stays busy until aborted. */
async function silentModel(t: any): Promise<string> {
	const socks = new Set<net.Socket>();
	const server = net.createServer(sock => { socks.add(sock); sock.on("error", () => {}); });
	await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
	t.after(() => { for (const s of socks) s.destroy(); server.close(); });
	return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`;
}

function project(t: any, opts: { tz?: string; loops?: any[]; gates?: Record<string, string>; prompts?: Record<string, string>; fireworks?: boolean; endpoint?: string; files?: Record<string, string> } = {}) {
	const cwd = tmp(t, "pi-loop-e2e-cwd-"), agent = tmp(t, "pi-loop-e2e-agent-");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { closed: {
		baseUrl: opts.endpoint ?? "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "none", models: [{ id: "none" }] } } }));
	for (const [rel, body] of Object.entries(opts.files ?? {})) {
		fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
		fs.writeFileSync(path.join(cwd, rel), body, { mode: rel.includes("/gates/") ? 0o755 : 0o644 });
	}
	const model = opts.fireworks ? { defaultProvider: "fireworks", defaultModel: MODEL, defaultThinkingLevel: "off" } : { defaultProvider: "closed", defaultModel: "none" };
	fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ ...model, ...(opts.tz ? { loop: { timezone: opts.tz } } : {}) }));
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

	constructor(t: any, p: { cwd: string; agent: string }, env: Record<string, string> = {}) {
		this.proc = spawn(PI, ["--mode", "rpc", "--no-session", "-e", PACKAGE], {
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
		if (this.proc.exitCode === null) this.proc.kill("SIGTERM");
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

test("a woken loop runs a real model turn to the end", { skip: fireworksKey() ? false : "set FIREWORKS_API_KEY or FIREWORKS_API_KEY_FILE to run against a real model" }, async t => {
	const p = project(t, { fireworks: true, loops: [{ ...due("ping"), prompt: "Reply with exactly the word pong and nothing else." }] });
	const pi = new Pi(t, p, { FIREWORKS_API_KEY: fireworksKey()! });
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
const real = fireworksKey() ? false : "set FIREWORKS_API_KEY or FIREWORKS_API_KEY_FILE to run against a real model";

test("asked for a daily job in a stated time zone, the agent makes one `at` loop in that zone", { skip: real }, async t => {
	const p = project(t, { fireworks: true });
	const pi = new Pi(t, p, { FIREWORKS_API_KEY: fireworksKey()! });
	await pi.ready();
	await pi.ask("Every day at 08:00 Tokyo time, write today's date to dates.txt in this folder.");
	const loops = p.loops();
	assert.equal(loops.length, 1, JSON.stringify(loops));
	assert.deepEqual([loops[0].schedule.kind, loops[0].schedule.hh, loops[0].schedule.mm, loops[0].tz], ["at", 8, 0, "Asia/Tokyo"]);
});

test("asked for a frequent check, the agent gates the loop so quiet fires cost no turn", { skip: real }, async t => {
	const p = project(t, { fireworks: true });
	fs.writeFileSync(path.join(p.cwd, "status.txt"), "OK\n");
	const pi = new Pi(t, p, { FIREWORKS_API_KEY: fireworksKey()! });
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

test("due loops wait while the session is busy, then fire once each, highest priority first, gate run when free", { timeout: 240_000 }, async t => {
	const endpoint = await silentModel(t);
	const p = project(t, {
		endpoint,
		loops: [
			{ ...due("often"), schedule: { kind: "every", ms: 60_000 }, catchUp: "none", nextAt: Date.now() + 20_000,
				gate: { command: ".pi/gates/stamp", timeoutMs: 10_000, onError: "wake" } },
			{ ...due("urgent"), priority: 5, nextAt: Date.now() + 20_000 },
		],
		gates: { stamp: '#!/bin/sh\ndate +%s >> "$LOOP_STATE_DIR/ran"\necho \'{"action":"wake","reason":"checked"}\'\n' },
	});
	const pi = new Pi(t, p);
	await pi.ready();
	const r = await pi.send({ type: "prompt", message: "a long task" });
	assert.equal(r.success, true);
	await pi.waitFor(l => l.type === "agent_start", 10_000);
	// Both come due while the model is still "thinking"; "often" (every 1m) comes due again too.
	await new Promise(res => setTimeout(res, 95_000));
	assert.deepEqual(pi.userMessages().filter(m => m.startsWith("[loop")), [], "nothing fires, nothing queues, while busy");
	assert.ok(!fs.existsSync(path.join(p.cwd, ".pi/loop-state/often/ran")), "the gate doesn't run while busy");
	const freedAt = Math.floor(Date.now() / 1000);
	await pi.send({ type: "abort" });

	const first = await pi.waitForUser(/^\[loop /, TICK * 2 + 5_000);
	assert.match(first, /^\[loop urgent · every 1h · fire #1 · waited \d+m?\d*s?/, "the higher priority goes first, marked as having waited");
	await new Promise(res => setTimeout(res, TICK + 3_000));
	assert.equal(pi.userMessages().filter(m => m.startsWith("[loop")).length, 1, "one at a time: the next waits for this turn");
	await pi.send({ type: "abort" });

	const second = await pi.waitForUser(/^\[loop often /, TICK * 3 + 5_000);
	assert.match(second, /fire #1 · waited .* · gate: checked\]/, "a short loop that waited fires once instead of being skipped");
	const ran = fs.readFileSync(path.join(p.cwd, ".pi/loop-state/often/ran"), "utf8").trim().split("\n").map(Number);
	assert.equal(ran.length, 1, "its gate ran once");
	assert.ok(ran[0] >= freedAt, "and only after the session was free");
	await pi.send({ type: "abort" });
	const byId = Object.fromEntries(p.loops().map((l: any) => [l.id, l]));
	assert.equal(byId.often.fires, 1, "no stacked copies");
	assert.equal(byId.urgent.fires, 1);
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
		// Run state from before (same id): kept, and due now.
		loops: [{ ...due("svc-check"), fires: 4 }],
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
