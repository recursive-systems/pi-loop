/**
 * The Pi runner's companion: loaded (-e) into the ordinary interactive Pi that IS a loop's run, in its terminal.
 * It tells the loop what this Pi is doing through the run's channel (PI_LOOP_CHANNEL, see channel.ts), every event
 * tagged with the run's attempt (PI_LOOP_ATTEMPT), and acts on what the loop asks for that attempt: the prompt, the
 * owner's words from elsewhere, stop, quit, and declining a dialog nobody answers. It writes facts only, never
 * model text, error messages or dialog wording. It draws nothing and changes nothing else.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Tail, sendEvent } from "./channel.ts";
import { watchLiveness } from "./liveness.ts";

const SHARED = Symbol.for("pi-loop.runner-pi");
interface Shared { tail?: Tail; pendingPrompt?: boolean; accepted?: boolean; quitting?: boolean; lastActivity: number; lastKeys: number; dialog?: boolean }

/** A short digest of an error message: enough to tell "the same error again" (Pi retried it), never its text. */
const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export default function (pi: ExtensionAPI) {
	const dir = process.env.PI_LOOP_CHANNEL, attempt = process.env.PI_LOOP_ATTEMPT;
	if (!dir || !attempt || !fs.existsSync(dir)) return;
	// Pi rebuilds extensions on a session switch: what this process has done lives on.
	const g = globalThis as any;
	const s: Shared = (g[SHARED] ??= { lastActivity: 0, lastKeys: 0 });
	s.tail ??= new Tail(path.join(dir, "commands.jsonl"));
	const ev = (e: object) => sendEvent(dir, { ...e, a: attempt });
	let ctx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const providers = (c: ExtensionContext) => {
		try { return [...new Set((c.modelRegistry as any).getAvailable().map((m: any) => m.provider))]; } catch { return undefined; }
	};
	const activity = () => { const now = Date.now(); if (now - s.lastActivity > 5_000) { s.lastActivity = now; ev({ e: "activity" }); } };

	/** A key into this Pi's own terminal input, as if typed (Escape closes a dialog). */
	let pressing = false;
	const press = (data: string) => { pressing = true; try { process.stdin.emit("data", Buffer.from(data)); } catch { /* no terminal */ } finally { pressing = false; } };

	// Test hooks (tests/runner.test.ts), read only from the run's own environment: hold the prompt before acting on it
	// (PI_LOOP_TEST_HOLD_PROMPT_MS), act on it but never say it was taken (PI_LOOP_TEST_NO_ACK), or refuse it (PI_LOOP_TEST_REFUSE).
	const hold = Number(process.env.PI_LOOP_TEST_HOLD_PROMPT_MS) || 0;
	async function command(c: any) {
		if (!ctx || c?.a !== attempt) return;
		if (c.c === "prompt" && hold) await new Promise(r => setTimeout(r, hold));
		if (c.c === "prompt" && process.env.PI_LOOP_TEST_REFUSE) { ev({ e: "refused", why: "refused by the test" }); return; }
		if (c.c === "prompt" && typeof c.file === "string") {
			let text: string;
			try { text = fs.readFileSync(c.file, "utf8"); } catch { ev({ e: "refused", why: "its prompt file is gone" }); return; }
			try { fs.rmSync(c.file, { force: true }); } catch { /* gone */ }
			const model = ctx.model;
			// Refused before it is sent on, so nothing ran: no model, or no credentials for it.
			if (!model) { ev({ e: "refused", why: "no model is selected in the run's Pi" }); return; }
			let auth = true;
			try { auth = (ctx.modelRegistry as any).hasConfiguredAuth(model); } catch { /* can't tell: Pi decides */ }
			if (!auth) { ev({ e: "refused", why: `Pi lists no credentials for ${model.provider}/${model.id}` }); return; }
			s.pendingPrompt = true; s.accepted = false;
			// An extension command is handled without a turn of its own (it may start one); it counts as taken once Pi has
			// dispatched it, as RPC's "handled" does. Its failure is an extension_error, which the run records.
			const name = text.startsWith("/") ? text.slice(1).split(/\s/)[0] : undefined;
			let isCommand = false;
			try { isCommand = !!name && (pi.getCommands?.() ?? []).some((x: any) => x.source === "extension" && x.name === name); } catch { /* older Pi */ }
			if (isCommand) { s.pendingPrompt = false; s.accepted = true; ev({ e: "accepted", disposition: "handled" }); }
			try { pi.sendUserMessage(text, { expandPromptTemplates: true, ...(ctx.isIdle() ? {} : { deliverAs: "followUp" }) } as any); }
			catch { if (isCommand) ev({ e: "extension_error" }); else { s.pendingPrompt = false; ev({ e: "refused", why: "Pi refused the prompt" }); } }
			return;
		}
		if (c.c === "say" && typeof c.text === "string") {
			try { pi.sendUserMessage(c.text, ctx.isIdle() ? undefined : { deliverAs: "steer" } as any); } catch { /* the loop sees no turn */ }
			return;
		}
		if (c.c === "abort") { try { ctx.abort(); } catch { /* idle */ } return; }
		if (c.c === "decline") { if (s.dialog) { ev({ e: "declined" }); press("\x1b"); } return; }
		if (c.c === "exit") { s.quitting = true; ev({ e: "exit", by: "loop" }); try { ctx.abort(); } catch { /* idle */ } try { ctx.shutdown(); } catch { /* gone */ } }
	}

	pi.on("session_start", (_e, c) => {
		ctx = c;
		ev({ e: "started", session: c.sessionManager.getSessionFile?.(), providers: providers(c) });
		// Pi fills its model list in the background: say again once it has.
		setTimeout(() => { if (ctx === c) ev({ e: "providers", providers: providers(c) }); }, 2_000).unref?.();
		try { c.ui.onTerminalInput?.(() => { if (pressing) return undefined; const now = Date.now(); if (now - s.lastKeys > 2_000) { s.lastKeys = now; ev({ e: "keys" }); } return undefined; }); } catch { /* no terminal */ }
		if (timer) clearInterval(timer);
		timer = setInterval(() => { for (const cmd of s.tail!.read()) void command(cmd); }, 250);
		timer.unref?.();
	});
	watchLiveness(pi, (_c, status) => ev({ e: "background", status }));

	// The owner typed into the run in its terminal: their words are part of the run.
	pi.on("input", (e: any) => { if (e.source === "interactive") ev({ e: "owner" }); });
	pi.on("agent_start", () => {
		if (s.pendingPrompt && !s.accepted && !process.env.PI_LOOP_TEST_NO_ACK) { s.accepted = true; s.pendingPrompt = false; ev({ e: "accepted", disposition: "started" }); }
		ev({ e: "working" });
	});
	pi.on("agent_settled", (e: any) => { ev({ e: "idle", aborted: !!e?.aborted }); });
	pi.on("message_update", () => activity());
	pi.on("message_end", (e: any) => {
		const m = e.message;
		if (m?.role !== "assistant") return;
		const content = (m.content ?? []).some((x: any) => x?.type === "toolCall" || (x?.type === "text" && x.text?.trim()) || (x?.type === "thinking" && x.thinking?.trim()));
		ev({ e: "answer", stop: m.stopReason, ...(m.stopReason === "error" ? { err: digest(String(m.errorMessage || "Unknown error")) } : {}),
			...(typeof m.provider === "string" && typeof m.model === "string" ? { model: `${m.provider}/${m.model}` } : {}), content });
	});
	pi.on("tool_execution_start", () => ev({ e: "tool" }));
	pi.on("tool_execution_update", () => activity());
	pi.on("session_before_compact", () => ev({ e: "compaction", phase: "start" }));
	pi.on("session_compact", () => ev({ e: "compaction", phase: "end" }));
	pi.on("session_compact_failed" as any, () => ev({ e: "compaction", phase: "end" }));
	pi.on("ui_prompt_start", () => { s.dialog = true; ev({ e: "dialog" }); });
	pi.on("ui_prompt_end", () => { s.dialog = false; ev({ e: "dialog_end" }); });
	pi.on("session_shutdown", (e: any) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		// Quitting ends the run; a switch (/new, /resume) keeps this Pi, whose next session_start says where it is.
		if ((!e?.reason || e.reason === "quit") && !s.quitting) ev({ e: "exit", by: "owner" });
		ctx = undefined;
	});
}
