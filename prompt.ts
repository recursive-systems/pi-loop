/**
 * Compose the user message a loop fire sends.
 *
 * A prompt template (`/check`) is expanded here, from its file on disk at fire
 * time, rather than by Pi. Two reasons:
 *  - Pi treats text after `/name` as template arguments: a template without
 *    `$@` drops them, and one with `$@` gets them shell-split (quotes removed,
 *    whitespace collapsed). The `[loop …]` header and `<gate-context>` JSON
 *    would be lost or mangled either way.
 *  - Pi loads templates at session start; reading the file at fire time means
 *    an edited prompt template takes effect on the next fire without /reload.
 *
 * Anything else starting with `/` (a skill or extension command) keeps the old
 * form: the command leads so Pi can dispatch it, header and context trail.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface CommandInfo { name: string; source: string; sourceInfo?: { path?: string } }

export interface Composed { text: string; expand: boolean; template?: string }

/** Pi's argument parsing for templates (bash-style quotes, whitespace splits). */
export function parseArgs(s: string): string[] {
	const out: string[] = [];
	let cur = "", q: string | null = null;
	for (const ch of s) {
		if (q) { if (ch === q) q = null; else cur += ch; }
		else if (ch === '"' || ch === "'") q = ch;
		else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ""; } }
		else cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

/** Pi's placeholder substitution: $1, $@, $ARGUMENTS, ${1:-d}, ${@:-d}, ${@:N}, ${@:N:L}. */
export function substitute(body: string, args: string[]): string {
	const all = args.join(" ");
	return body.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_m, dt, dv, ss, sl, simple) => {
			if (dt !== undefined) {
				const v = dt === "@" || dt === "ARGUMENTS" ? all : args[parseInt(dt, 10) - 1];
				return v ? v : dv;
			}
			if (ss !== undefined) {
				const start = Math.max(0, parseInt(ss, 10) - 1);
				return (sl !== undefined ? args.slice(start, start + parseInt(sl, 10)) : args.slice(start)).join(" ");
			}
			return simple === "@" || simple === "ARGUMENTS" ? all : (args[parseInt(simple, 10) - 1] ?? "");
		});
}

export function stripFrontmatter(s: string): string {
	const t = s.replace(/^\uFEFF/, "");
	const m = t.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
	return (m ? t.slice(m[0].length) : t).trim();
}

/** The template file for `/name`: the one Pi loaded, else the project's own. */
export function templatePath(name: string, cwd: string, commands: CommandInfo[]): string | undefined {
	const loaded = commands.find(c => c.name === name && c.source === "prompt" && c.sourceInfo?.path);
	if (loaded && fs.existsSync(loaded.sourceInfo!.path!)) return loaded.sourceInfo!.path;
	if (commands.some(c => c.name === name && c.source !== "prompt")) return undefined; // a command, not a template
	const local = path.join(cwd, ".pi", "prompts", `${name}.md`);
	return fs.existsSync(local) ? local : undefined;
}

export function compose(prompt: string, header: string, evidence: string, cwd: string, commands: CommandInfo[]): Composed {
	const m = prompt.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (m && !m[1].startsWith("skill:")) {
		const file = templatePath(m[1], cwd, commands);
		if (file) {
			try {
				const body = substitute(stripFrontmatter(fs.readFileSync(file, "utf8")), parseArgs(m[2] ?? ""));
				return { text: `${header}\n${body}${evidence}`, expand: false, template: file };
			} catch { /* unreadable now: let Pi expand its loaded copy */ }
		}
	}
	if (prompt.startsWith("/")) return { text: `${prompt}\n\n${header}${evidence}`, expand: true };
	return { text: `${header}\n${prompt}${evidence}`, expand: false };
}
