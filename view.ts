/**
 * The loops view (/loop in the terminal UI): every loop with its state, and a live view of a run you can steer.
 *
 *   list    ↑/↓ or j/k move · Enter watch its run · t go into its run · r run now · p pause/resume · x cancel its run · Esc close
 *   watch   type to steer, Enter sends · Tab go into the run · Esc back to the list
 */
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface LoopRow { id: string; state: string; detail: string; running: boolean; hasRun: boolean; unread: boolean; paused: boolean }
export type ViewAction = { action: "take" | "run" | "pause" | "resume" | "stop"; id: string } | undefined;

export interface ViewDeps {
	rows(): LoopRow[];
	lines(id: string): string[];
	steer(id: string, text: string): Promise<string>;
	seen(id: string): void;
	title: string;
}

export class LoopsView {
	focused = false;
	private sel = 0;
	private watching?: string;
	private input = "";
	private note = "";
	private timer: ReturnType<typeof setInterval>;

	constructor(private tui: { requestRender(): void }, private theme: any, private deps: ViewDeps, private done: (a: ViewAction) => void, watch?: string) {
		this.timer = setInterval(() => this.tui.requestRender(), 1000);
		if (watch) this.watch(watch);
	}

	private finish(a: ViewAction) { clearInterval(this.timer); this.done(a); }
	private fg(color: string, s: string) { try { return this.theme.fg(color, s); } catch { return s; } }
	private watch(id: string) { this.watching = id; this.input = ""; this.note = ""; this.deps.seen(id); }

	invalidate() {}

	/** Pi disposes the component when the interaction ends, however it ends. */
	dispose() { clearInterval(this.timer); }

	handleInput(data: string): void {
		const rows = this.deps.rows();
		if (this.watching) {
			const id = this.watching;
			if (matchesKey(data, "escape")) { this.watching = undefined; this.input = ""; this.tui.requestRender(); return; }
			if (matchesKey(data, "tab")) { this.finish({ action: "take", id }); return; }
			if (matchesKey(data, "return")) {
				const text = this.input.trim();
				this.input = "";
				if (text) { this.note = "sending…"; void this.deps.steer(id, text).then(r => { this.note = r; this.tui.requestRender(); }); }
				this.tui.requestRender(); return;
			}
			if (matchesKey(data, "backspace")) { this.input = this.input.slice(0, -1); this.tui.requestRender(); return; }
			if (data.length >= 1 && !data.startsWith("\x1b") && [...data].every(c => c >= " ")) { this.input += data; this.tui.requestRender(); }
			return;
		}
		if (matchesKey(data, "escape") || data === "q") { this.finish(undefined); return; }
		if (!rows.length) return;
		this.sel = Math.min(this.sel, rows.length - 1);
		const row = rows[this.sel];
		if (matchesKey(data, "up") || data === "k") this.sel = Math.max(0, this.sel - 1);
		else if (matchesKey(data, "down") || data === "j") this.sel = Math.min(rows.length - 1, this.sel + 1);
		else if (matchesKey(data, "return")) { if (row.hasRun || row.running) this.watch(row.id); else this.note = `${row.id} has no run yet`; }
		else if (data === "t") { if (row.hasRun || row.running) { this.finish({ action: "take", id: row.id }); return; } this.note = `${row.id} has no run to go into`; }
		else if (data === "r") { this.finish({ action: "run", id: row.id }); return; }
		else if (data === "p") { this.finish({ action: row.paused ? "resume" : "pause", id: row.id }); return; }
		else if (data === "x") { if (row.running) { this.finish({ action: "stop", id: row.id }); return; } this.note = `${row.id} has no run going`; }
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const out: string[] = [];
		const w = Math.max(1, width);
		const put = (s: string) => out.push(truncateToWidth(s, w));
		if (this.watching) {
			const id = this.watching;
			const row = this.deps.rows().find(r => r.id === id);
			put(this.fg("accent", `loop ${id}`) + this.fg("muted", ` · ${row?.state ?? "gone"}`));
			put(this.fg("muted", "─".repeat(Math.min(w, 80))));
			const lines = this.deps.lines(id).flatMap(l => l.split("\n")).slice(-18);
			if (!lines.length) put(this.fg("muted", "(nothing yet)"));
			for (const l of lines) put(l);
			put(this.fg("muted", "─".repeat(Math.min(w, 80))));
			put(`steer › ${this.input}${this.focused ? "▏" : ""}`);
			put(this.fg("muted", this.note || (row?.running ? "Enter sends (steered in at its next step) · Tab go into the run · Esc back" : "it isn't running: Enter starts a turn in it in the background · Tab go into it · Esc back")));
			return out;
		}
		put(this.fg("accent", `loops · ${this.deps.title}`));
		const rows = this.deps.rows();
		if (!rows.length) put(this.fg("muted", "No loops."));
		rows.forEach((r, i) => {
			const mark = i === this.sel ? "▸ " : "  ";
			const dot = r.running ? this.fg("accent", "● ") : r.unread ? this.fg("warning", "◆ ") : "  ";
			put(`${mark}${dot}${i === this.sel ? this.fg("accent", r.id) : r.id}  ${this.fg("muted", r.state)}`);
			if (r.detail) put(`      ${this.fg("muted", r.detail)}`);
		});
		put("");
		put(this.fg("muted", this.note || "Enter watch · t go in · r run now · p pause/resume · x cancel run · Esc close"));
		return out;
	}
}
