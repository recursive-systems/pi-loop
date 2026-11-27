#!/usr/bin/env node
// pi-loop: loop_report for a native agent (Claude Code, Codex) that has no Pi tool. Writes the same report a
// Pi run's loop_report writes, to $PI_LOOP_REPORT:
//   loop-report --findings false --summary "All healthy" [--ask "Reconnect Stripe"] [--next 2m] [--stop]
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2), opts = {};
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--stop") { opts.stop = true; continue; }
	const m = a.match(/^--(findings|summary|ask|next)(?:=(.*))?$/s);
	if (!m) { console.error(`loop-report: unknown argument ${a}`); process.exit(2); }
	opts[m[1]] = m[2] ?? args[++i];
	if (opts[m[1]] === undefined) { console.error(`loop-report: --${m[1]} needs a value`); process.exit(2); }
}
const file = process.env.PI_LOOP_REPORT;
if (!file) { console.error("loop-report: no loop run is in progress here (PI_LOOP_REPORT is not set), so there is nothing to report to"); process.exit(1); }
if (!["true", "false"].includes(String(opts.findings).toLowerCase())) { console.error("loop-report: --findings true|false is required"); process.exit(2); }
if (!opts.summary || !String(opts.summary).trim()) { console.error("loop-report: --summary \"one line\" is required"); process.exit(2); }
const report = { findings: String(opts.findings).toLowerCase() === "true", summary: String(opts.summary).trim(),
	...(opts.ask?.trim() ? { ask: opts.ask.trim().slice(0, 120) } : {}), ...(opts.next ? { next: String(opts.next) } : {}), ...(opts.stop ? { stop: true } : {}) };
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(report));
console.log("Reported.");
