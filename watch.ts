/**
 * Watching a loop's run, full screen: its conversation drawn with Pi's own message components (as if you
 * were in it), following it live from its session file, with a line to steer it and Tab to go into it.
 *
 *   PgUp/PgDn ↑/↓ scroll (Home/End: top, follow) · ctrl+o expand tool output · type + Enter steer
 *   Tab go into the run · Esc back
 */
import * as fs from "node:fs";
import {
	AssistantMessageComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent, CustomMessageComponent,
	ToolExecutionComponent, UserMessageComponent, parseSessionEntries, sessionEntryToContextMessages,
	createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
	createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export type WatchAction = "back" | "take" | undefined;

export interface WatchDeps {
	id: string;
	cwd: string;
	/** The run's session file (live run's, else its last one). */
	file(): string | undefined;
	/** The live run, if one is going. */
	live(): { working: boolean; lines: string[] } | undefined;
	state(): string;
	steer(text: string): Promise<string>;
	/** What Esc does, in the key line (default "back"). */
	escape?: string;
}

/** Full screen, over everything (pass as the overlay's options). */
export const FULL_SCREEN = { width: "100%", maxHeight: "100%", anchor: "top-left" } as const;

/** The most entries drawn (a fork carries the whole conversation it came from). */
const MAX_ENTRIES = 400;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function toolDefs(cwd: string): Record<string, any> {
	const out: Record<string, any> = {};
	const make: [string, (cwd: string) => any][] = [["bash", createBashToolDefinition], ["read", createReadToolDefinition], ["edit", createEditToolDefinition],
		["write", createWriteToolDefinition], ["grep", createGrepToolDefinition], ["find", createFindToolDefinition], ["ls", createLsToolDefinition]];
	for (const [name, fn] of make) { try { out[name] = fn(cwd); } catch { /* falls back to the generic look */ } }
	return out;
}

/** The entries on the conversation's current branch, oldest first. */
function branchOf(entries: any[]): any[] {
	const byId = new Map<string, any>();
	let leaf: any;
	for (const e of entries) if (e?.id) { byId.set(e.id, e); leaf = e; }
	const path: any[] = [];
	for (let e = leaf; e && path.length < MAX_ENTRIES; e = e.parentId ? byId.get(e.parentId) : undefined) path.push(e);
	return path.reverse();
}

export class RunWatch {
	focused = false;
	private chat = new Container();
	private seen = new Set<string>();
	private pending = new Map<string, any>();
	private tools: any[] = [];
	private file?: string;
	private mtime = -1;
	private cache?: { width: number; lines: string[] };
	private scroll = 0; // lines up from the bottom; 0 follows
	private input = "";
	private note = "";
	private expanded = false;
	private spin = 0;
	private timer: ReturnType<typeof setInterval>;
	private defs: Record<string, any>;

	constructor(private tui: any, private theme: any, private deps: WatchDeps, private done: (a: WatchAction) => void) {
		this.defs = toolDefs(deps.cwd);
		this.refresh();
		this.timer = setInterval(() => {
			const changed = this.refresh();
			const working = !!this.deps.live()?.working;
			if (working) this.spin = (this.spin + 1) % SPIN.length;
			if (changed || working) this.tui.requestRender();
		}, 250);
	}

	private fg(color: string, s: string) { try { return this.theme.fg(color, s); } catch { return s; } }
	private finish(a: WatchAction) { clearInterval(this.timer); this.done(a); }
	invalidate() { this.cache = undefined; this.chat.invalidate(); }
	dispose() { clearInterval(this.timer); }

	/** Reads what the run added to its file since last time; true if anything did. */
	private refresh(): boolean {
		const file = this.deps.file();
		if (file !== this.file) {
			this.file = file; this.mtime = -1;
			this.chat = new Container(); this.seen.clear(); this.pending.clear(); this.tools = [];
			this.cache = undefined;
		}
		if (!file) return false;
		let mtime: number;
		try { mtime = fs.statSync(file).mtimeMs; } catch { return false; }
		if (mtime === this.mtime) return false;
		this.mtime = mtime;
		let entries: any[];
		try { entries = parseSessionEntries(fs.readFileSync(file, "utf8")); } catch { return false; }
		for (const e of branchOf(entries)) {
			if (this.seen.has(e.id)) continue;
			this.seen.add(e.id);
			try { this.add(e); } catch { /* one entry Pi's components couldn't draw */ }
		}
		this.cache = undefined;
		return true;
	}

	private push(c: any) { this.chat.addChild(c); }

	private add(entry: any) {
		for (const m of sessionEntryToContextMessages(entry) as any[]) {
			switch (m.role) {
				case "user": {
					const text = typeof m.content === "string" ? m.content : (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
					if (!text) break;
					if (this.chat.children.length) this.push(new Spacer(1));
					this.push(new UserMessageComponent(text));
					break;
				}
				case "assistant": {
					this.push(new AssistantMessageComponent(m));
					for (const c of m.content ?? []) {
						if (c?.type !== "toolCall") continue;
						const t = new ToolExecutionComponent(c.name, c.id, c.arguments, { showImages: false }, this.defs[c.name], this.tui, this.deps.cwd);
						t.setExpanded(this.expanded);
						this.tools.push(t);
						this.push(t);
						if (m.stopReason === "aborted" || m.stopReason === "error")
							t.updateResult({ content: [{ type: "text", text: m.stopReason === "aborted" ? "Operation aborted" : m.errorMessage || "Error" }], isError: true });
						else this.pending.set(c.id, t);
					}
					break;
				}
				case "toolResult": {
					const t = this.pending.get(m.toolCallId);
					if (t) { t.updateResult(m); this.pending.delete(m.toolCallId); }
					break;
				}
				case "custom":
					if (m.display) { const c = new CustomMessageComponent(m, undefined); c.setExpanded?.(this.expanded); this.push(c); }
					break;
				case "compactionSummary":
					this.push(new Spacer(1)); this.push(new CompactionSummaryMessageComponent(m));
					break;
				case "branchSummary":
					this.push(new Spacer(1)); this.push(new BranchSummaryMessageComponent(m));
					break;
			}
		}
	}

	private bodyHeight(): number {
		const rows = Number(this.tui?.terminal?.rows) || 40;
		return Math.max(3, rows - 4);
	}

	handleInput(data: string): void {
		// Pasted text (a person's paste, or a multiplexer sending words to this terminal) goes into the steer line.
		const paste = /^\x1b\[200~([\s\S]*?)(?:\x1b\[201~)?(\r|\n)?$/.exec(data);
		if (paste) {
			this.input += paste[1].replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f]/g, "");
			if (paste[2]) data = "\r"; else { this.tui.requestRender(); return; }
		}
		const page = Math.max(1, this.bodyHeight() - 2);
		if (matchesKey(data, "escape")) { this.finish("back"); return; }
		if (matchesKey(data, "tab")) { this.finish("take"); return; }
		if (matchesKey(data, "pageUp")) this.scroll += page;
		else if (matchesKey(data, "pageDown")) this.scroll = Math.max(0, this.scroll - page);
		else if (matchesKey(data, "up")) this.scroll += 1;
		else if (matchesKey(data, "down")) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, "home")) this.scroll = Number.MAX_SAFE_INTEGER;
		else if (matchesKey(data, "end")) this.scroll = 0;
		else if (matchesKey(data, "ctrl+o")) {
			this.expanded = !this.expanded;
			for (const t of this.tools) { try { t.setExpanded(this.expanded); } catch { /* gone */ } }
			for (const c of this.chat.children as any[]) if (c instanceof CustomMessageComponent) { try { (c as any).setExpanded(this.expanded); } catch { /* */ } }
			this.cache = undefined;
		} else if (matchesKey(data, "return")) {
			const text = this.input.trim();
			this.input = "";
			if (text) {
				this.note = "sending…";
				void this.deps.steer(text).then(r => { this.note = r; this.tui.requestRender(); });
			}
		} else if (matchesKey(data, "backspace")) this.input = this.input.slice(0, -1);
		else if (data.length >= 1 && !data.startsWith("\x1b") && [...data].every(c => c >= " ")) this.input += data;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const body = this.bodyHeight();
		if (!this.cache || this.cache.width !== w) {
			let lines: string[] = [];
			try { lines = this.chat.render(w); } catch { /* */ }
			if (!lines.length) {
				const live = this.deps.live();
				lines = live?.lines.length ? live.lines.flatMap(l => l.split("\n")) : [this.fg("muted", " (nothing saved in its conversation yet)")];
			}
			this.cache = { width: w, lines };
		}
		const live = this.deps.live();
		const lines = live?.working ? [...this.cache.lines, "", this.fg("accent", ` ${SPIN[this.spin]} working…`)] : this.cache.lines;
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - body));
		const end = lines.length - this.scroll;
		const view = lines.slice(Math.max(0, end - body), end);
		while (view.length < body) view.unshift("");
		const pad = (s: string) => truncateToWidth(s, w, "", true);
		const head = this.fg("accent", ` loop ${this.deps.id}`) + this.fg("muted", ` · ${this.deps.state()}`) +
			(this.scroll ? this.fg("warning", ` · ${this.scroll} lines up (End follows)`) : "");
		const hint = this.note || `Enter steer · Tab go into the run · PgUp/PgDn scroll · ctrl+o expand tools · Esc ${this.deps.escape ?? "back"}`;
		return [
			pad(head),
			...view.map(pad),
			pad(this.fg("muted", "─".repeat(w))),
			pad(` steer › ${this.input}${this.focused ? "▏" : ""}`),
			pad(this.fg("muted", ` ${hint}`)),
		];
	}
}
