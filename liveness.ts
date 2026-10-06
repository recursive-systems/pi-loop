/** Child-only RPC companion. A settled model turn may still own detached work.
 *
 * Implements the documented session-liveness v1 host contract used by pi-subagents.
 * There is no package/host dependency: extensions register process-local callbacks;
 * only idle/busy/error crosses RPC, never their results or session content.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const LIVENESS_STATUS_KEY = "pi-loop:liveness:v1";
const REGISTRY = Symbol.for("@agegr/pi-web/session-liveness/v1");
const SHARED = Symbol.for("pi-loop.liveness.v1");
interface Provider { name: string; sessionId: string; sessionFile?: string; isActive(): boolean }
interface Shared { providers: Set<Provider>; registry: { version: 1; register(provider: Provider): () => void }; error: boolean }

export default function (pi: ExtensionAPI) {
	const global = globalThis as any;
	let shared: Shared = global[SHARED];
	if (!shared) {
		const providers = new Set<Provider>();
		shared = { providers, error: false, registry: { version: 1, register(provider) {
			if (!provider || typeof provider.name !== "string" || typeof provider.sessionId !== "string" ||
				!provider.sessionId || typeof provider.isActive !== "function" || providers.size >= 128) {
				shared.error = true;
				throw new Error("Invalid session-liveness provider");
			}
			providers.add(provider);
			return () => { providers.delete(provider); };
		} } };
		global[SHARED] = shared;
	}
	// Don't replace another host's registry. A conflict is unknown, never evidence of idle.
	if (global[REGISTRY] !== undefined && global[REGISTRY] !== shared.registry) shared.error = true;
	else global[REGISTRY] = shared.registry;

	let timer: ReturnType<typeof setInterval> | undefined;
	let previous: string | undefined;
	// A completion may reach the notifier just after the job's status turns inactive (or by a slower fallback poll).
	let busyUntil = 0;
	const owns = (p: Provider, ctx: ExtensionContext) => p.sessionId === ctx.sessionManager.getSessionId() ||
		p.sessionId === ctx.sessionManager.getSessionFile() ||
		(!!p.sessionFile && p.sessionFile === ctx.sessionManager.getSessionFile());
	function report(ctx: ExtensionContext) {
		let active = ctx.hasPendingMessages();
		try {
			if (global[REGISTRY] !== shared.registry) shared.error = true;
			for (const provider of shared.providers) if (owns(provider, ctx)) {
				const value = provider.isActive();
				if (typeof value !== "boolean") throw new Error("Invalid liveness response");
				active = active || value;
			}
		} catch { shared.error = true; }
		const now = Date.now();
		if (active) busyUntil = now + 5_000;
		const status = shared.error ? "error" : active || now < busyUntil ? "busy" : "idle";
		if (status !== previous) { previous = status; ctx.ui.setStatus(LIVENESS_STATUS_KEY, status); }
	}
	pi.on("session_start", (_event, ctx) => {
		if (timer) clearInterval(timer);
		previous = undefined; busyUntil = 0;
		report(ctx);
		timer = setInterval(() => report(ctx), 500);
		timer.unref?.();
	});
	pi.on("agent_settled", (_event, ctx) => report(ctx));
	pi.on("tool_call", (event, ctx) => {
		// Only pi-subagents' own tool: another extension may legitimately register a synchronous "subagent".
		if (event.toolName !== "subagent") return;
		const source = pi.getAllTools().find(t => t.name === "subagent")?.sourceInfo;
		const fromPiSubagents = /(^|[/\\:@])pi-subagents([/\\@]|$)/.test(`${source?.source ?? ""} ${source?.path ?? ""}`);
		if (fromPiSubagents && ![...shared.providers].some(p => p.name === "pi-subagents" && owns(p, ctx))) {
			return { block: true, reason: "This background loop can't safely delegate: its pi-subagents version doesn't report outstanding work to pi-loop. Update pi-subagents, or do the work without a subagent." };
		}
	});
	pi.on("session_shutdown", () => { if (timer) clearInterval(timer); timer = undefined; });
}
