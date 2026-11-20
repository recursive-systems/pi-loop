// Test-only: loaded into a loop run's Pi through the test's own agent dir (settings.json `extensions`), never shipped
// with or loaded by pi-loop. It reads `fault.json` in that agent dir and handles the loop's prompt (the message that
// starts with "[loop ") the way a faulty or slow run would, through Pi's own `input` event, before the agent starts:
//   { "hold": <ms> }   let it through only after this long
//   { "refuse": true } refuse it (writes the companion's `refused` fact to the channel) and drop it: nothing runs
//   { "silent": true } drop it and say nothing: an unacknowledged prompt
import fs from "node:fs";
import path from "node:path";

export default function (pi: any) {
	const dir = process.env.PI_LOOP_CHANNEL, attempt = process.env.PI_LOOP_ATTEMPT, agent = process.env.PI_CODING_AGENT_DIR;
	if (!dir || !attempt || !agent) return;
	let fault: any;
	try { fault = JSON.parse(fs.readFileSync(path.join(agent, "fault.json"), "utf8")); } catch { return; }
	pi.on("input", async (e: any) => {
		if (e.source !== "extension" || typeof e.text !== "string" || !e.text.startsWith("[loop ")) return { action: "continue" };
		if (fault.hold) await new Promise(r => setTimeout(r, fault.hold));
		if (fault.refuse) {
			fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ e: "refused", a: attempt, why: "refused by the test", at: Date.now() }) + "\n");
			return { action: "handled" };
		}
		if (fault.silent) return { action: "handled" };
		return { action: "continue" };
	});
}
