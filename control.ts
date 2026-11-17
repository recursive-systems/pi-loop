/**
 * A small local control channel: the session that owns the loops listens on a Unix socket, so a run's
 * standalone watcher (another Pi, in another terminal) can follow the run, steer it and take it over.
 *
 * The socket lives in a private folder (0700) and is itself 0600: only this user can connect. Messages are
 * newline-delimited JSON. A request carries `rid`; its answer carries the same `rid`. The host may also send
 * `{ type: "step", rid, text }` while it works on a request (a take-over's steps).
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** The socket for this process: under the agent dir, or a private temp folder when that path is too long for a socket. */
export function controlPath(agentDir: string): string {
	const name = `${process.pid}.sock`;
	const preferred = path.join(agentDir, "loop-hosts", "ctl");
	const dir = path.join(preferred, name).length < 100 ? preferred : path.join(os.tmpdir(), `pi-loop-ctl-${process.getuid?.() ?? "u"}`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
	return path.join(dir, name);
}

/** One connected watcher, as the host sees it. */
export class Peer {
	closed = false;
	private closers: (() => void)[] = [];
	constructor(private sock: net.Socket) {
		sock.on("close", () => { this.closed = true; for (const fn of this.closers.splice(0)) { try { fn(); } catch { /* one listener's problem */ } } });
	}
	send(obj: object) { if (!this.closed) { try { this.sock.write(JSON.stringify(obj) + "\n"); } catch { /* closing */ } } }
	onClose(fn: () => void) { if (this.closed) fn(); else this.closers.push(fn); }
	end() { try { this.sock.end(); } catch { /* gone */ } }
}

export type Handler = (msg: any, peer: Peer, step: (text: string) => void) => Promise<object>;

/** Listen at `file`; every request goes to `handle` (whichever instance is live when it comes). */
export function serve(file: string, handle: Handler): net.Server {
	try { fs.rmSync(file, { force: true }); } catch { /* none */ }
	const server = net.createServer(sock => {
		const peer = new Peer(sock);
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("error", () => { /* the watcher went away */ });
		sock.on("data", (d: string) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				let msg: any;
				try { msg = JSON.parse(line); } catch { continue; }
				const rid = msg?.rid;
				void handle(msg, peer, text => peer.send({ type: "step", rid, text }))
					.catch(e => ({ error: (e as Error).message }))
					.then(r => peer.send({ type: "reply", rid, ...r }));
			}
		});
	});
	server.on("error", () => { /* a failed listen leaves loops unaffected; watchers say the host is unreachable */ });
	const old = process.umask(0o177);
	try { server.listen(file); } finally { process.umask(old); }
	server.unref();
	return server;
}

/** A watcher's connection to the host. */
export class Client {
	private sock?: net.Socket;
	private buf = "";
	private seq = 0;
	private waiting = new Map<number, { resolve: (r: any) => void; step?: (t: string) => void }>();
	closed = false;
	private closers: (() => void)[] = [];

	constructor(private file: string) {}

	connect(): Promise<boolean> {
		return new Promise(resolve => {
			const sock = net.createConnection(this.file);
			let settled = false;
			sock.setEncoding("utf8");
			sock.on("connect", () => { settled = true; this.sock = sock; resolve(true); });
			sock.on("error", () => { if (!settled) { settled = true; this.closed = true; resolve(false); } });
			sock.on("close", () => {
				this.closed = true;
				for (const w of this.waiting.values()) w.resolve({ error: "the session that runs this loop is gone" });
				this.waiting.clear();
				for (const fn of this.closers.splice(0)) { try { fn(); } catch { /* */ } }
			});
			sock.on("data", (d: string) => {
				this.buf += d;
				let i;
				while ((i = this.buf.indexOf("\n")) >= 0) {
					const line = this.buf.slice(0, i);
					this.buf = this.buf.slice(i + 1);
					let msg: any;
					try { msg = JSON.parse(line); } catch { continue; }
					const w = this.waiting.get(msg.rid);
					if (!w) continue;
					if (msg.type === "step") { w.step?.(msg.text); continue; }
					this.waiting.delete(msg.rid);
					w.resolve(msg);
				}
			});
		});
	}

	onClose(fn: () => void) { if (this.closed) fn(); else this.closers.push(fn); }

	request(op: string, args: object = {}, step?: (text: string) => void, ms = 60_000): Promise<any> {
		if (this.closed || !this.sock) return Promise.resolve({ error: "the session that runs this loop is gone" });
		const rid = ++this.seq;
		return new Promise(resolve => {
			const t = setTimeout(() => { this.waiting.delete(rid); resolve({ error: "no answer from the session that runs this loop" }); }, ms);
			t.unref?.();
			this.waiting.set(rid, { resolve: r => { clearTimeout(t); resolve(r); }, step });
			try { this.sock!.write(JSON.stringify({ rid, op, ...args }) + "\n"); } catch { /* closing: answered by close */ }
		});
	}

	end() { try { this.sock?.end(); } catch { /* gone */ } }
}
