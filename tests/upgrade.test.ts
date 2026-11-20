// Upgrading in place: an interactive Pi running loops on an older pi-loop (a git checkout of a tag, PI_LOOP_OLD,
// default v0.19.1) is switched to this one with /reload while a background run is going, as a box upgrades. The
// loop's models come from tests/fixtures/fake-model.mjs, so a model answers, fails or is slow on cue, for free.
//
// Needs a pi-loop git checkout with that tag (the repository this runs from, or PI_LOOP_REPO). Skipped otherwise.
// Run: node --experimental-strip-types --test tests/upgrade.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const PI = process.env.PI_BIN || "pi";
const OLD = process.env.PI_LOOP_OLD || "v0.19.1";
const REPO = process.env.PI_LOOP_REPO || PACKAGE;
const TERMINAL = path.join(PACKAGE, "tests", "terminal.py");

function tmp(t: any, prefix: string) {
	const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** The older pi-loop as a package folder: a worktree of its tag, with this checkout's node_modules. */
function oldPackage(t: any): string | undefined {
	const dir = path.join(tmp(t, "pi-loop-up-old-"), "pkg");
	try { execFileSync("git", ["-C", REPO, "worktree", "add", "--detach", dir, OLD], { stdio: "ignore" }); } catch { return undefined; }
	t.after(() => { try { execFileSync("git", ["-C", REPO, "worktree", "remove", "--force", dir], { stdio: "ignore" }); } catch { /* gone */ } });
	try { fs.symlinkSync(path.join(PACKAGE, "node_modules"), path.join(dir, "node_modules")); } catch { /* none needed */ }
	return dir;
}

async function fakeModel(t: any): Promise<number> {
	const p = spawn(process.execPath, [path.join(PACKAGE, "tests/fixtures/fake-model.mjs")], { stdio: ["ignore", "pipe", "ignore"] });
	t.after(() => p.kill());
	return new Promise(resolve => p.stdout!.once("data", d => resolve(Number(String(d).trim()))));
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

/** A project whose pi-loop is the package at `link` (a symlink swapped to upgrade), and an interactive Pi in a pty. */
async function box(t: any, from: string) {
	const port = await fakeModel(t);
	const root = tmp(t, "pi-loop-up-"), cwd = path.join(root, "cwd"), agent = path.join(root, "agent"), link = path.join(root, "pkg");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true }); fs.mkdirSync(agent);
	fs.symlinkSync(from, link);
	fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "none",
		models: ["ok", "503", "slow-20000", "slow503-12000"].map(id => ({ id })) } } }));
	fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "ok", defaultProjectTrust: "always", retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } }));
	fs.writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify({ packages: [link], loop: { judge: "off", deepJudge: "off" } }));
	// A listener that records every loop:run event (and which code version's bus it heard it on) to events.jsonl.
	const probe = path.join(root, "probe.ts"), heard = path.join(root, "events.jsonl");
	fs.writeFileSync(probe, `import fs from "node:fs";
export default function (pi: any) {
	if (process.env.PI_LOOP_CHILD === "1") return;
	pi.events.on("loop:run", (e: any) => fs.appendFileSync(${JSON.stringify(heard)}, JSON.stringify({ phase: e.phase, attemptId: e.attemptId, fire: e.fire, status: e.status, at: Date.now() }) + "\\n"));
}
`);
	const pi: ChildProcess = spawn("python3", [TERMINAL, PI, "--session-dir", path.join(root, "sessions"), "-e", probe], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ["pipe", "pipe", "ignore"] });
	let out = ""; pi.stdout!.on("data", d => { out += d; });
	t.after(() => { pi.kill("SIGTERM"); setTimeout(() => pi.kill("SIGKILL"), 3000).unref(); });
	const type = async (s: string) => { pi.stdin!.write(s); await new Promise(r => setTimeout(r, 400)); };
	await until("Pi up", () => /loops|\u2500/.test(out), 30_000);
	await new Promise(r => setTimeout(r, 2500));
	const loop = () => JSON.parse(fs.readFileSync(path.join(cwd, ".pi/loops.json"), "utf8"))[0];
	let reloadedAt = 0;
	const upgrade = async () => { fs.unlinkSync(link); fs.symlinkSync(PACKAGE, link); await type("\x1b"); reloadedAt = Date.now(); await type("/reload\r"); };
	const events = (): any[] => { try { return fs.readFileSync(heard, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
	const gateLog = (): any[] => { try { return fs.readFileSync(path.join(cwd, ".pi/loops.log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
	const screen = () => out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
	return { cwd, type, loop, upgrade, screen, events, gateLog, reloadedAt: () => reloadedAt };
}

const old = (t: any) => { const o = oldPackage(t); if (!o) t.skip(`no ${OLD} in ${REPO}`); return o; };

test("upgrade mid-run: an accepted run whose model then fails falls back on the reloaded code and is recorded once", { timeout: 150_000 }, async t => {
	const from = old(t); if (!from) return;
	const b = await box(t, from);
	await b.type("/loop 1h --fresh --model fake/slow503-12000,fake/ok say hi\r");
	await b.type("/loop run say-hi\r");
	await until("its run accepted on the old code", () => b.loop()?.lastRun?.acceptance === "accepted", 30_000);
	const first = b.loop().lastRun;
	assert.equal(first.status, "running"); assert.equal(first.model, "fake/slow503-12000");
	await b.upgrade();
	const l = await until("recorded by the new code", () => ["done", "failed"].includes(b.loop()?.lastRun?.status) && b.loop(), 90_000);
	assert.equal(l.lastRun.status, "done", JSON.stringify(l.lastRun));
	// The fallback was launched after the reload (by the new scheduler): its fallback line and its attempt come later.
	const fb = b.gateLog().find(x => x.action === "fallback");
	assert.ok(fb && Date.parse(fb.ts) > b.reloadedAt(), `fallback after the reload: ${JSON.stringify(fb)}`);
	assert.notEqual(l.lastRun.attemptId, first.attemptId, "a new attempt");
	// The replacement attempt was announced and ended on the new code's bus.
	const ev = b.events().filter(e => e.attemptId === l.lastRun.attemptId);
	assert.deepEqual(ev.map(e => e.phase), ["start", "running", "end"], JSON.stringify(b.events()));
	assert.equal(ev[2].status, "done");
	assert.equal(l.lastRun.model, "fake/ok");
	assert.ok(l.lastRun.passedOver?.some((x: any) => x.model === "fake/slow503-12000"), JSON.stringify(l.lastRun.passedOver));
	assert.equal(l.fires, 1);
	assert.doesNotMatch(b.screen(), /TypeError|Cannot read properties/);
});

test("upgrade mid-start: a fallback before the prompt was sent (no credentials) moves on on the reloaded code", { timeout: 150_000 }, async t => {
	const from = old(t); if (!from) return;
	const b = await box(t, from);
	// "nocreds" is a provider with no key: Pi lists no credentials, so the old code falls back before sending.
	const agent = path.join(path.dirname(b.cwd), "agent"), models = JSON.parse(fs.readFileSync(path.join(agent, "models.json"), "utf8"));
	models.providers.nocreds = { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "x" }] };
	fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify(models));
	await b.type("/loop 1h --fresh --model nocreds/x,fake/slow-20000 say hi\r");
	await b.type("/loop run say-hi\r");
	// Upgrade while the old code is starting the first attempt (its credential check waits a few seconds).
	const first = await until("the first attempt starting on the old code", () => b.loop()?.lastRun?.status === "starting" && b.loop().lastRun, 20_000);
	assert.equal(first.model, "nocreds/x");
	await b.upgrade();
	assert.equal(b.loop().lastRun.attemptId, first.attemptId, "still the first attempt when the reload began");
	const l = await until("recorded", () => ["done", "failed"].includes(b.loop()?.lastRun?.status) && b.loop(), 120_000);
	assert.equal(l.lastRun.status, "done", JSON.stringify(l.lastRun));
	assert.notEqual(l.lastRun.attemptId, first.attemptId);
	const ev = b.events().filter(e => e.attemptId === l.lastRun.attemptId);
	assert.deepEqual(ev.map(e => e.phase), ["start", "running", "end"], "the fallback attempt was started and ended by the new code");
	assert.ok(ev[0].at > b.reloadedAt(), "after the reload");
	assert.equal(l.lastRun.model, "fake/slow-20000");
	assert.equal(l.fires, 1);
	assert.doesNotMatch(b.screen(), /TypeError|Cannot read properties/);
});

test("upgrade mid-run: a plain run started on the old code is recorded by the new one (its end event is the documented gap)", { timeout: 120_000 }, async t => {
	const from = old(t); if (!from) return;
	const b = await box(t, from);
	await b.type("/loop 1h --fresh --model fake/slow-20000 say hi\r");
	await b.type("/loop run say-hi\r");
	const first = await until("running on the old code", () => b.loop()?.lastRun?.status === "running" && b.loop().lastRun, 30_000);
	await b.upgrade();
	const l = await until("recorded", () => b.loop()?.lastRun?.status === "done" && b.loop(), 60_000);
	assert.equal(l.lastRun.result, "FAKE_OK");
	assert.equal(l.fires, 1);
	assert.equal(l.lastRun.attemptId, first.attemptId, "the old attempt itself, recorded by the new code");
	// Its start was heard on the old code's bus; its end, from the new code, is not (0.19.1 keeps its events in its own
	// module): a known gap of the first upgrade from a release, which is why switch.md drains runs before the reload.
	const ev = b.events().filter(e => e.attemptId === first.attemptId).map(e => e.phase);
	assert.deepEqual(ev.slice(0, 2), ["start", "running"]);
});
