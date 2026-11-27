/**
 * A loop run's watcher on its own: a Pi started with PI_LOOP_WATCH (the command in `loop:run` events' `watch`),
 * in any terminal. It shows the run full screen, as `/loop watch` does in the session that runs the loop, and
 * talks to that session over its control channel (control.ts) to steer the run and to take it over.
 *
 * Taking over: the session stops the run at a safe point and hands over its conversation; this Pi then runs an
 * interactive Pi on it, in this terminal, with the run's environment (so loop_report still reaches the loop).
 * When that Pi exits, the run is finished and recorded as with `/loop done`, and this watcher ends too.
 *
 * It also reports the run's state as the terminal's program status (OSC 7501), so a terminal or multiplexer
 * that shows program status shows the run's: working, done, failed, or needing the owner.
 */
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "./control.ts";
import { RunWatch, FULL_SCREEN, type WatchAction } from "./watch.ts";

interface Spec { socket: string; loop: string; fire: number }
interface State {
	error?: string; session?: string; live?: boolean; working?: boolean; backgroundWork?: boolean;
	status?: string; result?: string; ask?: string; needsYou?: boolean; away?: "here" | "elsewhere"; newer?: number;
}

/** OSC 7501, written by this watcher for the run it shows (only when its state changes). */
function programStatus(state: string, msg: string, kind?: string): string {
	const pairs = [`state=${state}`, "app=pi-loop"];
	if (kind) pairs.push(`kind=${kind}`);
	if (msg) pairs.push(`msg=${Buffer.from(msg.slice(0, 500), "utf8").toString("base64")}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

export function standaloneWatch(pi: ExtensionAPI, raw: string) {
	let spec: Spec;
	try { spec = JSON.parse(raw); if (!spec?.socket || !spec.loop || !spec.fire) throw new Error("incomplete"); }
	catch { pi.on("session_start", (_e, c) => { try { c.ui.notify("PI_LOOP_WATCH isn't a run this Pi can watch", "warning"); } catch { /* no UI */ } }); return; }
	const title = `loop ${spec.loop} #${spec.fire}`;
	const client = new Client(spec.socket);
	let state: State = {};
	let connected = false;
	let opened = false;
	let lastStatus = "";
	/** Redraws the watcher when the run's state changes (its file may not have). */
	let redraw: (() => void) | undefined;
	const reportStatus = () => {
		if (!process.stdout.isTTY) return;
		let s: [string, string, string?];
		if (!connected) s = ["error", `${title}: the session that runs this loop is gone`];
		else if (state.away) s = ["idle", `${title}: taken over`];
		else if (state.live) s = ["working", title];
		else if (state.needsYou) s = ["blocked", state.ask || state.result || title, "question"];
		else if (state.status === "failed") s = ["error", state.result || `${title} failed`];
		else if (state.status === "done") s = ["done", state.result || title];
		else if (state.status === "replaced") s = ["done", `${title} ended · #${state.newer} has run since`];
		else if (state.status === "starting" || state.status === "running") s = ["working", title];
		else s = ["idle", state.result || title];
		const out = programStatus(...s);
		if (out !== lastStatus) { lastStatus = out; try { process.stdout.write(out); } catch { /* closed */ } }
	};
	const describe = (): string => {
		if (!connected) return "the session that runs this loop is gone";
		if (state.error) return state.error;
		if (state.away === "elsewhere") return "taken over in another terminal";
		if (state.away === "here") return "the owner is in it, in the session that runs the loop";
		if (state.live) return `running (${state.working ? "working" : state.backgroundWork ? "waiting on background work" : "idle"})`;
		const st = state.status === "replaced" ? "ended" : state.status ?? "starting";
		return `${st}${state.result ? `: ${state.result.split("\n")[0]}` : ""}${state.newer ? ` · #${state.newer} has run since` : ""}`;
	};
	const refresh = async () => {
		if (!connected) return;
		const r = await client.request("state", { loop: spec.loop, fire: spec.fire }, undefined, 10_000);
		if (r.error && client.closed) connected = false;
		// The owner falls back to "starting" when it no longer has this run's details.
		if (r.status === "starting" && r.newer) r.status = "replaced";
		const changed = JSON.stringify(r) !== JSON.stringify(state);
		state = r;
		reportStatus();
		if (changed) redraw?.();
	};

	async function watch(c: any): Promise<void> {
		if (!connected) connected = await client.connect();
		client.onClose(() => { connected = false; reportStatus(); redraw?.(); });
		await refresh();
		const timer = setInterval(() => { void refresh(); }, 1_000);
		let action: WatchAction;
		try {
			action = await c.ui.custom((tui: any, theme: any, _kb: any, done: (a: WatchAction) => void) => { redraw = () => tui.requestRender(); return new RunWatch(tui, theme, {
				id: `${spec.loop} #${spec.fire}`,
				cwd: process.cwd(),
				file: () => state.session,
				live: () => (state.live ? { working: !!state.working, lines: [] } : undefined),
				state: describe,
				steer: async (text: string) => {
					const r = await client.request("steer", { loop: spec.loop, fire: spec.fire, text });
					return r.error ?? r.text ?? "sent";
				},
				escape: "close",
			}, done); }, { overlay: true, overlayOptions: FULL_SCREEN });
		} finally { clearInterval(timer); redraw = undefined; }
		if (action !== "take") { client.end(); c.shutdown(); return; }
		await take(c);
	}

	async function take(c: any): Promise<void> {
		const say = (s?: string) => { try { c.ui.setStatus("loop", s ? `${title}: ${s}` : undefined); } catch { /* no UI */ } };
		say("asking the session that runs it to hand it over");
		const r = await client.request("take", { loop: spec.loop, fire: spec.fire }, step => say(step), 120_000);
		say(undefined);
		if (r.error || !Array.isArray(r.argv) || !r.argv.length) {
			try { c.ui.notify(`couldn't take over ${title}: ${r.error ?? "no conversation to open"}`, "warning"); } catch { /* */ }
			return watch(c);
		}
		const env: NodeJS.ProcessEnv = { ...process.env, ...(r.env ?? {}) };
		delete env.PI_LOOP_WATCH;
		// The watch command turned off this Pi's own status reports; the Pi you go into reports its own.
		if (process.env.PI_PROGRAM_STATUS === "0") delete env.PI_PROGRAM_STATUS;
		const code: number | null = await c.ui.custom((tui: any, _t: any, _k: any, done: (n: number | null) => void) => {
			tui.stop();
			process.stdout.write("\x1b[2J\x1b[H");
			const res = spawnSync(r.argv[0], r.argv.slice(1), { stdio: "inherit", cwd: r.cwd ?? process.cwd(), env });
			tui.start();
			tui.requestRender(true);
			done(res.status);
			return { render: () => [], invalidate: () => {} };
		});
		await client.request("finished", { loop: spec.loop, fire: spec.fire, code }, undefined, 15_000);
		state = { status: "done", result: "taken over and finished" };
		lastStatus = "";
		connected = !client.closed;
		reportStatus();
		client.end();
		c.shutdown();
	}

	pi.registerCommand("loop-watch", {
		description: `Watch ${title} (this Pi is its standalone watcher)`,
		handler: async (_args: string, c: any) => {
			if (opened) return;
			opened = true;
			try { await watch(c); } finally { opened = false; }
		},
	});
	pi.registerCommand("loop", {
		description: `This Pi watches ${title}; /loop-watch opens it again`,
		handler: async (_args: string, c: any) => { try { c.ui.notify(`This Pi watches ${title}. /loop-watch shows it; its loops belong to the session that runs them.`, "info"); } catch { /* */ } },
	});
	let started = false;
	pi.on("session_start", (_e, c) => {
		if (started || c.mode !== "tui") return;
		started = true;
		// A command, so the watcher has a command context (overlays, shutdown); sent once the session is up.
		setTimeout(() => { try { pi.sendUserMessage("/loop-watch", { expandPromptTemplates: true } as any); } catch { /* */ } }, 0);
	});
}
