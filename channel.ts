/**
 * A terminal run's channel: a private folder per attempt through which a run in a terminal (an ordinary
 * interactive agent, not a child on a pipe) tells the loop what it is doing, and the loop tells it what to do.
 *
 *   events.jsonl     appended by the run (its companion extension, its hooks via bin/loop-run.mjs, and the launcher)
 *   commands.jsonl   appended by the loop's session; read by a run that can act on them (Pi's companion)
 *   start            the launcher's one-time socket and token, removed as the launcher reads it
 *   prompt-<a>.txt   a prompt delivered through the channel, removed as the run reads it
 *
 * Every event carries `a`, the attempt it belongs to; a reader ignores events of any other attempt. Events hold
 * facts only, never model text, error messages, dialog wording or steering text: the record keeps what a hidden
 * run's would (pi-loop's RPC path keeps only the fact of an extension failure, not its diagnostic).
 *   spawned {pid} / exited {code}            the launcher: the agent's process started / ended
 *   started {session?, session_id?, providers?}  the agent is up
 *   accepted {disposition}                   it took the loop's prompt: "started" a turn, or "handled" it as a command
 *   working / idle                           a turn started / it settled (nothing more will happen by itself)
 *   background {status: busy|idle|error}     it still owns detached work after settling (session-liveness v1)
 *   answer {model?, stop?, content, err?}    an assistant message ended; err is a short digest of the error, for retry counting
 *   extension_error                          an extension failed (the fact only)
 *   tool / activity                          it did work / is still making progress
 *   compaction {phase: start|end}            preflight compaction, which may delay acceptance
 *   dialog / dialog_end / declined           it waits on a person / no longer / pi-loop declined it
 *   keys / owner                             someone typed into it / sent it words in its terminal
 *   exit {by}                                it is closing normally
 * Commands, each with `a`: {c: "prompt", file}, {c: "say", text}, {c: "abort"}, {c: "decline"}, {c: "exit"}.
 *
 * Files are 0600 in a 0700 folder. Once a run is recorded, its channel keeps only events.jsonl; folders are
 * pruned to the newest few per loop, never one whose agent is still running.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const CHANNEL_ENV = "PI_LOOP_CHANNEL";

export function makeChannel(dir: string): string {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(dir, 0o700); } catch { /* not ours */ }
	for (const f of ["events.jsonl", "commands.jsonl"]) fs.writeFileSync(path.join(dir, f), "", { mode: 0o600 });
	return dir;
}

function append(file: string, obj: object) {
	fs.appendFileSync(file, JSON.stringify({ ...obj, at: Date.now() }) + "\n", { mode: 0o600 });
}
export function sendEvent(dir: string, e: object) { try { append(path.join(dir, "events.jsonl"), e); } catch { /* the channel is gone: nobody listens */ } }
export function sendCommand(dir: string, c: object) { append(path.join(dir, "commands.jsonl"), c); }

/** Reads new complete lines of a JSONL file from where it last stopped. */
export class Tail {
	private offset = 0;
	private rest = "";
	constructor(readonly file: string) {}
	read(): any[] {
		let fd: number;
		try { fd = fs.openSync(this.file, "r"); } catch { return []; }
		const out: any[] = [];
		try {
			const size = fs.fstatSync(fd).size;
			if (size < this.offset) { this.offset = 0; this.rest = ""; }
			if (size === this.offset) return out;
			const buf = Buffer.alloc(size - this.offset);
			fs.readSync(fd, buf, 0, buf.length, this.offset);
			this.offset = size;
			const text = this.rest + buf.toString("utf8");
			const lines = text.split("\n");
			this.rest = lines.pop() ?? "";
			for (const l of lines) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* not a record */ } }
		} finally { fs.closeSync(fd); }
		return out;
	}
}

/** Everything in a finished attempt's channel but its events (prompt, commands, start file, a runner's files). */
export function scrubChannel(dir: string) {
	let names: string[] = [];
	try { names = fs.readdirSync(dir); } catch { return; }
	for (const n of names) if (n !== "events.jsonl") { try { fs.rmSync(path.join(dir, n), { force: true, recursive: true }); } catch { /* gone */ } }
}
export function removeChannel(dir: string) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }

/**
 * Keep the newest `keep` channel folders under `root` (a loop's runs/); remove older ones, except those `live`
 * says are still running (an agent still there owns its channel), which are scrubbed of nothing and kept.
 */
export function pruneChannels(root: string, keep: number, live: (dir: string) => boolean) {
	let dirs: { d: string; m: number }[] = [];
	try { dirs = fs.readdirSync(root).map(n => path.join(root, n)).map(d => ({ d, m: fs.statSync(d).mtimeMs })); } catch { return; }
	dirs.sort((a, b) => b.m - a.m);
	for (const { d } of dirs.slice(keep)) { if (!live(d)) removeChannel(d); }
}
