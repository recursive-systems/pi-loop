/**
 * Herdr pane tokens for loops: the next fire as a countdown in Herdr's Agent
 * sidebar. Display-only (`pane.report_metadata`); Herdr's own Pi integration
 * keeps lifecycle state. Render with `$loop` in ui.sidebar.agents rows; see
 * README.md for the config snippet.
 *
 *   $loop        "○ judge in 2h05m" · "◔ judge in 3m" · "● judge running" · "◌ 2 paused"
 *   $loop_state  waiting | soon | queued | running | paused
 *   $loop_in     whole seconds to the next fire (for numeric rules); absent unless waiting/soon
 *
 * The leading glyph carries the state so a single-token rule (`starts_with`)
 * can style it. Tokens carry a TTL and are refreshed while the session lives,
 * so a crashed session's countdown expires instead of freezing.
 */

import * as net from "node:net";

export const SOON_MS = 5 * 60_000;
export const TOKEN_TTL_MS = 90_000;
const REFRESH_MS = 45_000;
const SOURCE = "pi-loop";

export type Phase = { state: "queued" | "running"; id: string } | undefined;
export type Tokens = { loop: string | null; loop_state: string | null; loop_in: string | null };

export const CLEARED: Tokens = { loop: null, loop_state: null, loop_in: null };

interface LoopView { id: string; paused: boolean; nextAt: number }

/** "<1m", "14m", "2h05m", "1d3h": whole minutes rounded up, so it never reads "0m" before firing. */
export function countdown(ms: number): string {
	if (ms < 60_000) return "<1m";
	const mins = Math.ceil(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const h = Math.floor(mins / 60), m = mins % 60;
	if (h < 24) return `${h}h${String(m).padStart(2, "0")}m`;
	const d = Math.floor(h / 24), rh = h % 24;
	return rh ? `${d}d${rh}h` : `${d}d`;
}

export function loopTokens(loops: LoopView[], now: number, phase: Phase): Tokens {
	if (!loops.length) return CLEARED;
	if (phase) {
		const glyph = "●";
		return { loop: `${glyph} ${phase.id} ${phase.state}`, loop_state: phase.state, loop_in: null };
	}
	const active = loops.filter(l => !l.paused);
	if (!active.length) return { loop: `◌ ${loops.length} paused`, loop_state: "paused", loop_in: null };
	const next = active.reduce((a, b) => (b.nextAt < a.nextAt ? b : a));
	const left = Math.max(0, next.nextAt - now);
	const soon = left <= SOON_MS;
	return {
		loop: `${soon ? "◔" : "○"} ${next.id} in ${countdown(left)}`,
		loop_state: soon ? "soon" : "waiting",
		loop_in: String(Math.floor(left / 1000)),
	};
}

/** Sends token patches to this pane; no-op outside a Herdr pane. */
export class HerdrTokens {
	private last = JSON.stringify(CLEARED);
	private lastSentAt = 0;
	private seq = Date.now() * 1000;
	private readonly socket = process.env.HERDR_SOCKET_PATH;
	private readonly pane = process.env.HERDR_PANE_ID;

	get enabled(): boolean {
		return process.env.HERDR_ENV === "1" && !!this.socket && !!this.pane;
	}

	/** Report when the text changed, or to refresh the TTL; never re-send a clear. */
	update(tokens: Tokens, now = Date.now()): void {
		if (!this.enabled) return;
		const key = JSON.stringify(tokens);
		const cleared = key === JSON.stringify(CLEARED);
		if (key === this.last && (cleared || now - this.lastSentAt < REFRESH_MS)) return;
		this.last = key;
		this.lastSentAt = now;
		this.send(tokens, cleared);
	}

	clear(): void {
		this.update(CLEARED);
	}

	private send(tokens: Tokens, cleared: boolean): void {
		const request = {
			id: `loop_${this.seq}`,
			method: "pane.report_metadata",
			params: { pane_id: this.pane, source: SOURCE, tokens, seq: ++this.seq, ...(cleared ? {} : { ttl_ms: TOKEN_TTL_MS }) },
		};
		const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${this.socket}` : this.socket!;
		try {
			const sock = net.createConnection(endpoint);
			const done = () => sock.destroy();
			const timer = setTimeout(done, 1500);
			timer.unref?.();
			sock.on("error", done);
			sock.on("connect", () => sock.write(`${JSON.stringify(request)}\n`));
			sock.on("data", () => { clearTimeout(timer); done(); });
			sock.unref?.();
		} catch { /* display-only; never break the loop */ }
	}
}
