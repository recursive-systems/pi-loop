#!/usr/bin/env node
// How an agent in a terminal tells pi-loop what its loop run is doing: called from the agent's own lifecycle
// hooks (or by the agent itself, to report). It reads PI_LOOP_CHANNEL and PI_LOOP_REPORT from its environment,
// which the run's terminal was started with, so it works the same for any agent. See RUNNERS.md.
//
//   loop-run.mjs event <name> [key=value ...]   append an event (started, prompt, working, idle, tool, answer,
//                                               dialog, dialog_end, background, exit). A hook's JSON on stdin is
//                                               read too: session_id, model, last_assistant_message, and for
//                                               answer its stop reason, are taken from it.
//   loop-run.mjs report --findings true|false --summary "..." [--ask "..."] [--next 15m] [--stop]
//
// It never prints anything a hook would read as a decision, and always exits 0: a run's hooks must not fail
// because the loop isn't listening.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.PI_LOOP_CHANNEL;
const [cmd, ...args] = process.argv.slice(2);

function stdinJson() {
	if (process.stdin.isTTY) return {};
	try { const t = fs.readFileSync(0, "utf8"); return t.trim() ? JSON.parse(t) : {}; } catch { return {}; }
}
function event(e) {
	if (!dir) return;
	try { fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ ...e, at: Date.now() }) + "\n", { mode: 0o600 }); } catch { /* not listening */ }
}

try {
	if (cmd === "event" && args[0]) {
		const e = { e: args[0] };
		for (const kv of args.slice(1)) { const i = kv.indexOf("="); if (i > 0) e[kv.slice(0, i)] = kv.slice(i + 1); }
		const h = stdinJson();
		if (typeof h.session_id === "string") e.session_id = h.session_id;
		if (typeof h.model === "string" && !e.model) e.model = h.model;
		if (typeof h.last_assistant_message === "string") e.text = h.last_assistant_message.slice(0, 4000);
		if (typeof h.title === "string" && !e.title) e.title = h.title.slice(0, 200);
		if (typeof h.message === "string" && e.e === "dialog" && !e.title) e.title = h.message.slice(0, 200);
		if (e.e === "started") e.pid = Number(e.pid) || process.ppid;
		if (e.e === "answer") e.content = e.content !== "false";
		event(e);
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
