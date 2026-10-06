/**
 * One owner per folder, using an OS lock held by a Perl helper. The helper releases when its
 * parent's stdin closes. Never unlink the lock file: all contenders must lock the same inode.
 * Plain pid metadata lets older pi-loop readers see a live owner; extra metadata is a sidecar.
 * Perl is available on macOS and many Linux installations; without it callers fail closed.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const HOLD = 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or exit 2; flock($f, LOCK_EX | LOCK_NB) or exit 1; $| = 1; print "ok\\n"; 1 while <STDIN>;';
let perl: boolean | undefined;
export function lockAvailable(): boolean {
	if (perl === undefined) perl = spawnSync("perl", ["-MFcntl=:flock", "-e", "1"], { stdio: "ignore", timeout: 5000 }).status === 0;
	return perl;
}

export function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
export interface Owner { pid: number; token?: string; since?: number; [k: string]: unknown }

export class FolderLock {
	readonly token = randomUUID();
	private holder?: ChildProcessWithoutNullStreams;
	private candidate?: ChildProcessWithoutNullStreams;
	private claiming?: Promise<boolean>;
	private generation = 0;
	/** onLost: called once if the lock is lost while held (its helper died), not on release(). */
	constructor(readonly file: string, private extra: Record<string, unknown> = {}, private onLost?: () => void) {}

	owner(): Owner | undefined {
		let pid = 0;
		try { pid = Number(fs.readFileSync(this.file, "utf8").trim().split(/\s/)[0]) || 0; } catch { /* none */ }
		if (!(pid > 0)) return undefined;
		try { const o = JSON.parse(fs.readFileSync(`${this.file}.owner`, "utf8")); if (Number(o.pid) === pid) return o; } catch { /* none */ }
		return { pid };
	}
	mine(): boolean { return !!this.holder && this.holder.exitCode === null && this.holder.signalCode === null; }

	claim(): Promise<boolean> {
		if (this.mine()) return Promise.resolve(true);
		if (this.claiming) return this.claiming;
		if (!lockAvailable()) return Promise.resolve(false);
		try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); } catch { return Promise.resolve(false); }
		const generation = this.generation;
		this.claiming = new Promise<boolean>(resolve => {
			const child = spawn("perl", ["-e", HOLD, this.file], { stdio: ["pipe", "pipe", "ignore"] }) as ChildProcessWithoutNullStreams;
			this.candidate = child;
			let out = "", settled = false;
			const done = (ok: boolean) => {
				if (settled) return;
				settled = true;
				if (this.candidate === child) this.candidate = undefined;
				this.claiming = undefined;
				resolve(ok);
			};
			const timer = setTimeout(() => { child.kill(); done(false); }, 5000);
			child.stdin.on("error", () => { /* pipe closed during cancellation */ });
			child.on("error", () => { clearTimeout(timer); done(false); });
			child.on("exit", () => {
				clearTimeout(timer);
				if (this.holder === child) {
					this.holder = undefined;
					try { this.onLost?.(); } catch { /* the caller's problem */ }
				}
				done(false);
			});
			child.stdout.on("data", d => {
				out += d;
				if (settled || !out.includes("ok\n")) return;
				clearTimeout(timer);
				if (generation !== this.generation) { child.stdin.end(); done(false); return; }
				const was = this.owner();
				if (was && !was.token && was.pid !== process.pid && pidAlive(was.pid)) { child.stdin.end(); done(false); return; }
				try {
					fs.writeFileSync(`${this.file}.owner`, JSON.stringify({ ...this.extra, pid: process.pid, token: this.token, since: Date.now() }), { mode: 0o600 });
					fs.writeFileSync(this.file, `${process.pid}\n`, { mode: 0o600 });
				} catch { child.stdin.end(); done(false); return; }
				this.holder = child;
				// Keep handles referenced until the handshake completes: ensure/startup callers may
				// have no other event-loop work. An acquired lock must not keep its parent alive.
				child.unref(); (child.stdout as any).unref?.(); (child.stdin as any).unref?.();
				done(true);
			});
		});
		return this.claiming;
	}

	release() {
		this.generation++;
		this.candidate?.stdin.end();
		const h = this.holder;
		if (!h) return;
		this.holder = undefined;
		try {
			if (JSON.parse(fs.readFileSync(`${this.file}.owner`, "utf8")).token === this.token) {
				fs.writeFileSync(this.file, "");
				fs.unlinkSync(`${this.file}.owner`);
			}
		} catch { /* metadata isn't authority; the OS lock is */ }
		h.stdin.end();
	}
}
