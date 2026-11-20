#!/usr/bin/env node
// A loop run in a terminal, from the terminal's side. See RUNNERS.md and channel.ts.
//
//   loop-run.mjs start <channel>               what the terminal runs: fetches the run's environment and argv from the
//                                              session that runs the loop (a private socket, a one-time token; nothing
//                                              of them on disk), starts the agent in this terminal, waits for it, and
//                                              records its exit
//   loop-run.mjs event <name> [key=value ...]  append an event (started, prompt, working, idle, tool, answer, dialog,
//                                              dialog_end, background, exit), from an agent's lifecycle hooks. Of a
//                                              hook's JSON on stdin only session_id and model are taken: no text.
//   loop-run.mjs report --findings true|false --summary "..." [--ask "..."] [--next 15m] [--stop]
//
// `event` and `report` never print anything a hook would read as a decision, and always exit 0: a run's hooks must
// not fail because the loop isn't listening.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const [cmd, ...args] = process.argv.slice(2);

function append(dir, e) {
	try { fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ ...e, at: Date.now() }) + "\n", { mode: 0o600 }); } catch { /* not listening */ }
}
function stdinJson() {
	if (process.stdin.isTTY) return {};
	try { const t = fs.readFileSync(0, "utf8"); return t.trim() ? JSON.parse(t) : {}; } catch { return {}; }
}

if (cmd === "start") {
	const dir = args[0];
	let spec;
	try { spec = JSON.parse(fs.readFileSync(path.join(dir, "start"), "utf8")); } catch { console.error("pi-loop: this run's start file is gone (already started, or the loop gave up on it)"); process.exit(2); }
	try { fs.rmSync(path.join(dir, "start"), { force: true }); } catch { /* */ }
	const reply = await new Promise(resolve => {
		const sock = net.createConnection(spec.socket);
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("connect", () => sock.write(JSON.stringify({ token: spec.token, pid: process.pid }) + "\n"));
		sock.on("data", d => { buf += d; });
		sock.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({ error: "no answer" }); } });
		sock.on("error", () => resolve({ error: "the session that runs this loop isn't reachable" }));
	});
	if (!reply?.argv?.length) { console.error(`pi-loop: couldn't start this run: ${reply?.error ?? "no answer"}`); append(dir, { e: "exited", a: spec.attempt, code: 2 }); process.exit(2); }
	append(dir, { e: "spawned", a: spec.attempt, pid: process.pid });
	const env = { ...process.env, ...reply.env };
	delete env.BUN_BE_BUN;
	// The agent shares this process group: a signal to the group (the loop stopping it, the terminal closing) reaches
	// both; this launcher outlives it only to record its exit.
	for (const s of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) process.on(s, () => { /* the agent gets it too */ });
	const child = spawn(reply.argv[0], reply.argv.slice(1), { stdio: "inherit", cwd: reply.cwd, env });
	child.on("error", () => { append(dir, { e: "exited", a: spec.attempt, code: 127 }); process.exit(127); });
	child.on("exit", (code, signal) => { append(dir, { e: "exited", a: spec.attempt, code: code ?? 128, ...(signal ? { signal } : {}) }); process.exit(code ?? 1); });
} else {
	try {
		if (cmd === "event" && args[0]) {
			const dir = process.env.PI_LOOP_CHANNEL, attempt = process.env.PI_LOOP_ATTEMPT;
			const e = { e: args[0], a: attempt };
			for (const kv of args.slice(1)) { const i = kv.indexOf("="); if (i > 0) e[kv.slice(0, i)] = kv.slice(i + 1); }
			const h = stdinJson();
			if (typeof h.session_id === "string") e.session_id = h.session_id.slice(0, 200);
			if (typeof h.model === "string" && !e.model) e.model = h.model.slice(0, 200);
			if (e.e === "answer") e.content = e.content !== "false";
			for (const k of ["text", "title", "message", "error", "prompt"]) delete e[k]; // facts only, never their words
			if (dir && attempt) append(dir, e);
		} else if (cmd === "report") {
			const file = process.env.PI_LOOP_REPORT;
			const o = {};
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a === "--stop") o.stop = true;
				else if (a.startsWith("--") && args[i + 1] !== undefined) o[a.slice(2)] = args[++i];
			}
			if (!file) { console.log("No loop run is in progress here, so there is nothing to report to."); }
			else {
				const rep = { findings: o.findings === "true", summary: String(o.summary ?? ""), ...(o.ask ? { ask: String(o.ask).slice(0, 120) } : {}), ...(o.next ? { next: o.next } : {}), ...(o.stop ? { stop: true } : {}) };
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, JSON.stringify(rep));
				console.log("Reported.");
			}
		}
	} catch { /* never fail a hook */ }
	process.exit(0);
}
