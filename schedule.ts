/**
 * Pure schedule math for loops. Daily `at` times are wall-clock times in an
 * IANA zone, computed through Intl so daylight-saving changes are honoured:
 * 07:30 America/Chicago is 12:30Z in CDT and 13:30Z in CST.
 *
 * DST edges follow the usual cron-like convention:
 * - a wall time skipped by spring-forward (02:30 on that day) fires at the
 *   same offset past the gap, i.e. 03:30;
 * - a wall time repeated by fall-back (01:30 twice) fires once, the first time.
 */

export type Schedule = { kind: "every"; ms: number } | { kind: "at"; hh: number; mm: number };

export const MIN_INTERVAL_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 10 * 60_000;

export function parseInterval(token: string): number | undefined {
	const m = /^(\d+)(s|m|h|d)$/i.exec(token);
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = m[2].toLowerCase();
	return n * (unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
}

export function parseAt(token: string): { hh: number; mm: number } | undefined {
	const m = /^(\d{1,2}):(\d{2})$/.exec(token);
	if (!m) return undefined;
	const hh = Number(m[1]);
	const mm = Number(m[2]);
	if (hh > 23 || mm > 59) return undefined;
	return { hh, mm };
}

// ------------------------------------------------------------- time zones --

/** Canonical IANA name if `tz` is a zone this runtime knows, else undefined. */
export function validZone(tz: string | undefined): string | undefined {
	const name = tz?.trim();
	if (!name) return undefined;
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
	} catch {
		return undefined;
	}
}

export function systemZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

interface Wall { y: number; mo: number; d: number; h: number; mi: number }

function wall(ts: number, tz: string): Wall {
	let f = partsFormatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz, hourCycle: "h23",
			year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
		});
		partsFormatters.set(tz, f);
	}
	const p: Record<string, number> = {};
	for (const part of f.formatToParts(ts)) if (part.type !== "literal") p[part.type] = Number(part.value);
	return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute };
}

/** Zone offset (ms east of UTC) in effect at instant `ts`. */
function offsetAt(ts: number, tz: string): number {
	const w = wall(ts, tz);
	const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
	return asUtc - Math.floor(ts / 60_000) * 60_000;
}

/** The instant a wall-clock time occurs in `tz` (first occurrence; shifted past a DST gap). */
export function wallToInstant(y: number, mo: number, d: number, hh: number, mm: number, tz: string): number {
	const naive = Date.UTC(y, mo - 1, d, hh, mm);
	// The offsets either side of any transition near this wall time.
	const before = offsetAt(naive - 36 * 3_600_000, tz);
	const after = offsetAt(naive + 36 * 3_600_000, tz);
	const hits = [...new Set([before, after])]
		.map(o => naive - o)
		.filter(t => { const w = wall(t, tz); return w.h === hh && w.mi === mm && w.d === new Date(naive).getUTCDate(); })
		.sort((a, b) => a - b);
	if (hits.length) return hits[0];
	// Skipped by spring-forward: keep the pre-transition offset, landing past the gap.
	return naive - before;
}

const DAY_MS = 86_400_000;

export function nextAtFor(s: Schedule, from: number, anchor: number, tz: string): number {
	if (s.kind === "every" && s.ms % DAY_MS === 0) return nextDayGrid(s.ms / DAY_MS, from, anchor, tz);
	if (s.kind === "every") {
		// Advance from the planned grid (anchor + k*ms), no completion drift.
		const k = Math.floor((from - anchor) / s.ms) + 1;
		return anchor + Math.max(k, 1) * s.ms;
	}
	const today = wall(from, tz);
	for (let day = 0; day <= 2; day++) {
		const date = new Date(Date.UTC(today.y, today.mo - 1, today.d + day));
		const t = wallToInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), s.hh, s.mm, tz);
		if (t > from) return t;
	}
	throw new Error(`no next occurrence for ${s.hh}:${s.mm} in ${tz}`);
}

/**
 * Whole-day intervals (1d, 7d) are calendar steps in the zone, keeping the
 * anchor's wall-clock time, so a daily loop stays at 15:43 local across DST
 * instead of drifting an hour with a fixed 24 h grid.
 */
function nextDayGrid(days: number, from: number, anchor: number, tz: string): number {
	const a = wall(anchor, tz);
	const subMinute = anchor - Math.floor(anchor / 60_000) * 60_000;
	const f = wall(from, tz);
	const dayIndex = (w: Wall) => Math.round(Date.UTC(w.y, w.mo - 1, w.d) / DAY_MS);
	const elapsed = dayIndex(f) - dayIndex(a);
	for (let k = Math.max(1, Math.floor(elapsed / days)); ; k++) {
		const date = new Date(Date.UTC(a.y, a.mo - 1, a.d + k * days));
		const t = wallToInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), a.h, a.mi, tz) + subMinute;
		if (t > from) return t;
	}
}

// ---------------------------------------------------------------- display --

const pad = (n: number) => String(n).padStart(2, "0");

export function zoneAbbrev(ts: number, tz: string): string {
	try {
		const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
			.formatToParts(ts).find(p => p.type === "timeZoneName");
		return part?.value ?? tz;
	} catch {
		return tz;
	}
}

export function describe(s: Schedule, tz?: string): string {
	if (s.kind === "at") return `daily at ${pad(s.hh)}:${pad(s.mm)}${tz ? ` ${tz}` : ""}`;
	const ms = s.ms;
	if (ms % 86_400_000 === 0) return `every ${ms / 86_400_000}d${tz ? ` (${tz})` : ""}`;
	if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
	return `every ${ms / 60_000}m`;
}

/** "07:30 CDT" today, "09-25 07:30 CDT" otherwise; days are judged in `tz`. */
export function fmtTime(ts: number, tz: string, now = Date.now()): string {
	const w = wall(ts, tz);
	const n = wall(now, tz);
	const hm = `${pad(w.h)}:${pad(w.mi)} ${zoneAbbrev(ts, tz)}`;
	const sameDay = w.y === n.y && w.mo === n.mo && w.d === n.d;
	return sameDay ? hm : `${pad(w.mo)}-${pad(w.d)} ${hm}`;
}
