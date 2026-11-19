/**
 * A terminal run's channel: a private folder per attempt through which a run in a terminal (an ordinary
 * interactive agent, not a child on a pipe) tells the loop what it is doing, and the loop tells it what to do.
 *
 *   events.jsonl     appended by the run (its companion extension, or its hooks via bin/loop-run.mjs)
 *   commands.jsonl   appended by the loop's session; read by a run that can act on them (Pi's companion)
 *   prompt-<n>.txt   a prompt for a run whose prompt is delivered through the channel
 *
 * Events, one JSON object per line, each with `e` (and `at`, epoch ms, added on write):
 *   started   {pid?, session?, providers?}   the agent is up (and which providers it has credentials for)
 *   accepted  {disposition?}                 it took the loop's prompt: "started" a turn, or "handled" it as a command
 *   working / idle                           a turn started / it settled (nothing more will happen by itself)
 *   background {status: busy|idle|error}     it still owns detached work after settling (Pi's liveness contract)
 *   answer    {model?, stop?, content?}      an assistant message ended (stop "error" or "aborted" for failures)
 *   tool                                     a tool ran (it did work)
 *   activity                                 still making progress (at most every few seconds)
 *   compaction {phase: start|end}            preflight compaction, which may delay acceptance
 *   dialog    {title?} / dialog_end          it waits on a person / no longer
 *   owner                                    someone typed into it in its terminal
 *   exit                                     it is closing normally (the owner quit it, or it was asked to)
 * Commands: {c: "prompt", file}, {c: "say", text}, {c: "abort"}, {c: "exit"}.
 *
 * Files are 0600 in a 0700 folder. Nothing is ever read from a channel but these records.
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

/** Keep the newest `keep` channel folders under `root` (a loop's runs/), remove older ones. */
export function pruneChannels(root: string, keep: number, except?: string) {
	let dirs: { d: string; m: number }[] = [];
	try { dirs = fs.readdirSync(root).map(n => path.join(root, n)).filter(d => d !== except).map(d => ({ d, m: fs.statSync(d).mtimeMs })); } catch { return; }
	dirs.sort((a, b) => b.m - a.m);
	for (const { d } of dirs.slice(keep)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* in use */ } }
}
