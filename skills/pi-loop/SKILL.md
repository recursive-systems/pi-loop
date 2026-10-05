---
name: pi-loop
description: How to set up loops (recurring prompts in this session, the loop_manage tool and /loop) well. Covers where the loop's instructions live, choosing a schedule, and writing a gate script that decides whether a due loop wakes the model, so frequent checks stay cheap. Use before creating a loop that runs more often than hourly, writing or debugging a gate, or when a loop costs too much or misses its time.
---

# Loops that work

A loop re-sends its prompt to this same session on a schedule. Each fire is a full model turn
with the whole conversation as context. Every rule below follows from that.

## 1. Put the instructions in a prompt template

Write what the loop should do in `.pi/prompts/<name>.md` and make the loop's prompt `/<name>`.
The loop reads the file each time it fires, so an edit applies on the next fire with no
`/reload`, and the loop itself stays one short line. Inside the template, say:

- what to check or do,
- where the result goes (a file, a message, a PR comment, an issue): a loop turn's output stays
  in this session unless the prompt sends it somewhere,
- what "nothing to do" looks like, so the turn can end in one line.

## 2. Pick the schedule

- `every` for checks (`5m`, `1h`). Under one hour, add a gate (below), or every fire costs a turn.
- `at HH:MM` for daily work at a wall-clock time. It follows daylight saving in the loop's
  `timezone`, the `loop.timezone` setting, or else the machine's zone. Ask the user for their zone
  rather than assuming one.
- `list` first: don't create a second loop for the same job. Change or delete the existing one.
- Loops fire only while a Pi session is open in this project. If a run must never be missed,
  recommend the system scheduler (cron, launchd, a systemd timer) instead.

## 3. Gate frequent loops

A gate is an executable file inside the project (for example `.pi/gates/check`). It runs when
the loop is due and prints one JSON line as its last line of output:

```json
{"action": "skip", "reason": "no new failures"}
{"action": "wake", "reason": "2 jobs failing", "context": "build #812: test_auth timeout"}
{"action": "defer", "reason": "just failed, confirm", "retryIn": "60s"}
```

- `skip`: no model turn. `wake`: the prompt is sent with `· gate: <reason>` in its header and
  `context` (up to 4 KB) in a `<gate-context>` block. `defer`: run the gate again after `retryIn`
  (15 s minimum).
- It runs without a shell, with cwd = the project and a 60 s timeout (`gateTimeout` to change).
  Environment: `LOOP_ID`, `LOOP_PROMPT`, `LOOP_LAST_WOKE_AT`, `LOOP_STATE_DIR` (its own folder
  for memory between runs), `PI_SESSION_ID`, `PI_SESSION_FILE`, and `LOOP_TEST=1` on a test run.
- An error (non-zero exit, timeout, no JSON) wakes the model once, then reminds every 6 h until
  the gate works again. `gateOnError: "skip"` reverses that. `maxSleep` wakes the model anyway
  once that long has passed since the last wake: a heartbeat.

Make gates cheap and honest:

1. Let code check facts and compare them with the last run (in `$LOOP_STATE_DIR`). If nothing
   changed, skip.
2. For fuzzy questions about text ("same incident as before?", "does a human need this today?"),
   ask a small decision model a typed question and apply a threshold in code. That can be a
   System-1 classifier, or a cheap LLM asked for strict JSON. Cache answers by a hash of the
   input, and if that model is unreachable, decide on the code checks alone.
3. Do routine work (collect, sort, dedupe) in the gate itself, and wake only when there's
   something for the model to decide.
4. With `LOOP_TEST=1`, decide but record nothing.

Test before relying on it: `loop_manage test` (or `/loop test <id>`) runs the gate once and
shows its decision without waking. You can also run the file by hand with
`LOOP_STATE_DIR=/tmp/x LOOP_TEST=1 .pi/gates/check`. Every decision is appended to
`.pi/loops.log.jsonl`.

## 4. When it fires

The message starts with `[loop <id> · <schedule> · fire #N …]`. Do the template's work, send the
result where it says, and keep "nothing to do" turns to one line. To stop or change the loop,
use `loop_manage` (`pause`, `delete`, `gate`). Don't just ignore the loop.
