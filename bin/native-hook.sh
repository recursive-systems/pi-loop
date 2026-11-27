#!/bin/sh
# pi-loop: what a native agent's hooks call (Claude Code hooks and status line, Codex notify).
# One fact per line in $PI_LOOP_NATIVE_DIR/events.jsonl; the status line's JSON (usage) in usage.json.
# Writes nothing anywhere else and never fails the agent.
d="${PI_LOOP_NATIVE_DIR:-}"
[ -n "$d" ] && [ -d "$d" ] || { [ "$1" = status ] && echo "loop run"; exit 0; }
now() { date +%s%3N 2>/dev/null || date +%s000; }
case "$1" in
	event)
		input=$(tr -d '\n\r')
		[ -n "$input" ] || input=null
		printf '{"e":"%s","t":%s,"in":%s}\n' "$2" "$(now)" "$input" >> "$d/events.jsonl" ;;
	notify)
		# Codex passes its JSON as the last argument.
		for last; do :; done
		input=$(printf '%s' "$last" | tr -d '\n\r')
		printf '{"e":"notify","t":%s,"in":%s}\n' "$(now)" "${input:-null}" >> "$d/events.jsonl" ;;
	status)
		cat > "$d/usage.json.tmp" 2>/dev/null && mv -f "$d/usage.json.tmp" "$d/usage.json"
		printf '%s\n' "${PI_LOOP_NATIVE_LABEL:-loop run}" ;;
esac
exit 0
