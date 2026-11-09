/** Local metadata only. No prompts, gate reasons, reports, errors or model/provider data. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface LoopOrigin {
	id: string;
	incarnation: number;
	revision: number;
	folder: string;
	workDir: string;
}
export interface HostSnapshot {
	sessionId?: string;
	state: "owner" | "readonly" | "switching" | "stopped";
	untrackedActive?: number;
	loops: (LoopOrigin & { owned: boolean; paused: boolean; mode: string; nextAt: number; expiresAt?: number })[];
}
export interface LifecycleData {
	event: "attempt" | "accepted" | "terminal" | "gate" | "interruption" | "handoff" | "dispatch_blocked" | "foreground_queued" | "foreground_running";
	loop: LoopOrigin;
	attemptId?: string;
	evaluationId?: string;
	fire?: number;
	mode?: string;
	by?: "schedule" | "gate" | "heartbeat" | "manual" | "resume" | "leave";
	status?: string;
	acceptance?: "accepted" | "not_accepted" | "unknown";
	session?: string;
	findings?: boolean;
	hasAsk?: boolean;
	needsPermission?: boolean;
	action?: "wake" | "skip" | "defer";
	error?: boolean;
}

/** One writer per random host id; survives extension replacement through the process-wide owner. */
export class LifecycleHost {
	readonly id = randomUUID();
	readonly startedAt = Date.now();
	private sequence = 0;
	private committedSequence = 0;
	private streams: { file: string; firstSequence: number }[] = [];
	private stream?: { file: string; bytes: number; dev: number; ino: number };
	private failures = 0;
	private gaps = 0;
	private errorCode?: string;
	private snapshot?: HostSnapshot;
	private lastRegistration = 0;
	private registered = "";

	constructor(readonly root: string, readonly schedulerCwd: string, readonly version: string) {}

	get error(): string | undefined { return this.errorCode; }

	private dirs() {
		fs.mkdirSync(path.join(this.root, "hosts"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(this.root, "streams"), { recursive: true, mode: 0o700 });
	}

	/** Fsync before rename; a failed update never replaces the last complete registration. */
	update(snapshot: HostSnapshot, force = false) {
		// Keep the registration metadata-only too, even if a caller supplies additional fields.
		this.snapshot = { sessionId: snapshot.sessionId, state: snapshot.state, untrackedActive: snapshot.untrackedActive ?? 0, loops: snapshot.loops.map(l => ({
			id: l.id, incarnation: l.incarnation, revision: l.revision, folder: l.folder, workDir: l.workDir,
			owned: l.owned, paused: l.paused, mode: l.mode, nextAt: l.nextAt, expiresAt: l.expiresAt,
		})) };
		const identity = JSON.stringify(this.snapshot);
		if (!force && identity === this.registered && Date.now() - this.lastRegistration < 60_000) return;
		let tmp: string | undefined;
		try {
			this.dirs();
			const file = path.join(this.root, "hosts", this.id + ".json");
			tmp = file + "." + randomUUID() + ".tmp";
			const fd = fs.openSync(tmp, "wx", 0o600);
			try {
				fs.writeFileSync(fd, JSON.stringify({ v: 1, hostId: this.id, pid: process.pid,
					version: this.version, schedulerCwd: this.schedulerCwd, startedAt: this.startedAt, observedAt: Date.now(), ...this.snapshot,
					streams: this.streams, sequence: this.sequence, committedSequence: this.committedSequence,
					reportingFailures: this.failures, gaps: this.gaps, ...(this.errorCode ? { errorCode: this.errorCode } : {}),
				}) + "\n");
				fs.fsyncSync(fd);
			} finally { fs.closeSync(fd); }
			fs.renameSync(tmp, file);
			this.syncDir(path.dirname(file));
			this.registered = identity;
			this.lastRegistration = Date.now();
		} catch (e) { this.failed(e); }
		finally { if (tmp) { try { fs.unlinkSync(tmp); } catch { /* absent */ } } }
	}

	/** A source observer must treat a stale registration, missing sequence or reporting gap as partial. */
	append(data: LifecycleData): boolean {
		const sequence = ++this.sequence;
		let fd: number | undefined;
		try {
			this.dirs();
			if (!this.stream) {
				const file = path.join(this.root, "streams", this.id + "-" + randomUUID() + ".jsonl");
				fd = fs.openSync(file, "wx", 0o600);
				const st = fs.fstatSync(fd);
				this.stream = { file, bytes: 0, dev: st.dev, ino: st.ino };
				this.streams.push({ file, firstSequence: sequence });
				this.syncDir(path.dirname(file));
			} else {
				fd = fs.openSync(this.stream.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
				const st = fs.fstatSync(fd);
				if (st.dev !== this.stream.dev || st.ino !== this.stream.ino || st.size !== this.stream.bytes)
					throw Object.assign(new Error("lifecycle stream changed"), { code: "ESTALE" });
			}
			// Explicit projection: passing an object with extra fields cannot export its payload.
			const { id, incarnation, revision, folder, workDir } = data.loop;
			const row = { v: 1, eventId: randomUUID(), hostId: this.id, sequence, at: Date.now(),
				schedulerCwd: this.schedulerCwd, sessionId: this.snapshot?.sessionId, event: data.event,
				loop: { id, incarnation, revision, folder, workDir }, attemptId: data.attemptId,
				evaluationId: data.evaluationId, fire: data.fire, mode: data.mode, by: data.by, status: data.status,
				acceptance: data.acceptance, session: data.session, findings: data.findings,
				hasAsk: data.hasAsk, needsPermission: data.needsPermission, action: data.action, error: data.error };
			const text = JSON.stringify(row) + "\n";
			fs.writeFileSync(fd, text);
			fs.fsyncSync(fd);
			this.stream.bytes += Buffer.byteLength(text);
			this.committedSequence = sequence;
		} catch (e) {
			this.failed(e);
			this.gaps++;
			// Preserve even torn/replaced originals. Future writes use a NEW segment, never truncate/rewrite.
			this.stream = undefined;
			return false;
		} finally {
			if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { this.failed(e); this.gaps++; this.stream = undefined; } }
			if (this.snapshot) this.update(this.snapshot, true);
		}
		return true;
	}

	private failed(error: unknown) {
		this.failures++;
		const code = (error as NodeJS.ErrnoException)?.code;
		// Never copy an exception message, path, child output or credential-bearing diagnostic.
		this.errorCode = typeof code === "string" && code.length <= 32 && [...code].every(c => c >= "A" && c <= "Z") ? code : "EIO";
	}
	private syncDir(dir: string) {
		const fd = fs.openSync(dir, "r");
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	}
}
