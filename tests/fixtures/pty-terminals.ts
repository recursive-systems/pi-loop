// A terminal provider for the tests: answers pi-loop's `loop:terminal` requests by running the run in a real
// pseudo-terminal (tests/terminal.py), with no multiplexer. It records what it opened in PTY_LOG and keeps each
// terminal's output in PTY_DIR/<id>.out, so a test can see the run's screen and type into it (PTY_DIR/<id>.in, a FIFO).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export default function (pi: any) {
	const dir = process.env.PTY_DIR, log = process.env.PTY_LOG;
	if (!dir || process.env.PI_LOOP_CHANNEL || process.env.PI_LOOP_CHILD === "1") return;
	const helper = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "terminal.py");
	let n = 0;
	pi.events.on("loop:terminal", (r: any) => {
		if (r?.v !== 1) return;
		if (r.op === "probe") { r.here(); return; }
		if (r.op !== "open") return;
		r.inherit.push("PTY_*");
		r.provide((async () => {
			await r.ready;
			const id = `p${++n}-${process.pid}`;
			const fifo = path.join(dir, `${id}.in`);
			fs.mkdirSync(dir, { recursive: true });
			try { fs.rmSync(fifo, { force: true }); } catch { /* none */ }
			spawn("mkfifo", [fifo]).on("exit", () => {});
			await new Promise(res => setTimeout(res, 200));
			const out = fs.openSync(path.join(dir, `${id}.out`), "a");
			// sh -c keeps the FIFO open for writing too, so the terminal's input never sees an end while tests type into it.
			const p = spawn("sh", ["-c", `exec 3<>${JSON.stringify(fifo)}; exec python3 ${JSON.stringify(helper)} "$@" <&3`, "sh", ...r.argv],
				{ cwd: r.cwd, stdio: ["ignore", out, out], detached: true, env: { ...process.env, PTY_ID: id } });
			p.unref();
			if (log) fs.appendFileSync(log, JSON.stringify({ id, loop: r.loop, fire: r.fire, runner: r.runner, name: r.name, pid: p.pid }) + "\n");
			return {
				id, attach: `pty ${id}`,
				close: async () => { try { process.kill(-p.pid!, "SIGTERM"); } catch { /* gone */ } },
				send: async (text: string) => { fs.appendFileSync(fifo, text + "\r"); return undefined; },
			};
		})());
	});
}
