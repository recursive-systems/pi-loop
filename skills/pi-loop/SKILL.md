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
- It runs without a shell, with cwd = the loop's folder (the project, or its `dir`) and a 60 s
  timeout (`gateTimeout` to change).
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

## 4. Several jobs in one session

One session can carry several responsibilities, each a loop:

- **A loop waits while the session is busy.** It isn't queued behind the current turn and never
  stacks: a 5-minute check through a 20-minute turn fires once, afterwards, and its gate runs then,
  so the evidence is fresh. The header then says `· waited 18m`. When several are waiting,
  `priority` (higher first) decides, then the longest overdue.
- **Give each job its own folder** (`dir`): its gate, its `.pi/prompts/<name>.md` and its state
  live there, so two folders can each have a `/check`. `context: ["AGENTS.md"]` attaches that
  folder's instructions to the job's turns only. Gate paths are relative to the folder.
- **Declare loops in files** so adding a job is adding a folder. `.pi/loop.json` in the project or
  in any folder directly under it:

  ```json
  {"loops": [{"id": "api-check", "prompt": "/check", "every": "5m", "gate": ".pi/gates/check",
              "maxSleep": "12h", "context": ["AGENTS.md"], "priority": 1}]}
  ```

  Fields are those of `loop_manage create` (`every` or `at`, `timezone`, `gate`, `maxSleep`,
  `gateTimeout`, `gateOnError`, `priority`, `context`, `run`, `model`), plus `paused` and `until`. One file
  per project is the way forward; folders under the project still work for setups that use them. The folder holding the file is
  the loop's folder. Edits apply within a tick; deleting the entry deletes the loop. An id already
  used by a `loop_manage` loop is refused. Change a declared loop in its file: `loop_manage`
  `delete` and `gate` refuse it; `pause` and `resume` work until the file's `paused` changes.

## 5. In the background, or watching something

- **`run`** puts a loop's turn beside the conversation instead of in it: `fork` (a copy of the
  conversation as it is then: use it when the job needs what was said), `thread` (the loop's own
  conversation, continued each run: for jobs that build on their last run) or `fresh` (a new
  conversation each run: for self-contained checks; the cheapest). Leave it out to run in the A background run starts in the loop's own folder,
  so that folder's `.pi/mcp.json`, settings, prompts and AGENTS.md apply (no need for `context`
  then); `"model": "provider/id:thinking"` gives it its own model. `loop.folders` in the project's
  settings adopts sibling folders (`["../business"]`) whose loops this session also runs.
  conversation as before. The owner watches, steers and steps into runs from `/loop`.
- **Watching something for a while** (a deploy, a PR, a migration): an ad hoc loop with `every: auto`
  and `for` (how long at most). Each run picks the next time with `loop_report` `next` (short while it
  changes, long when quiet) and ends the loop with `stop: true` when it's done. Ad hoc loops end after
  7 days unless `for`/`until` says otherwise; standing jobs belong in `.pi/loop.json`.

## 6. When it fires

The message starts with `[loop <id> · <schedule> · fire #N …]`. Do the template's work, send the
result where it says, and keep "nothing to do" turns to one line. End with `loop_report`: findings
true only if there is something the owner should see (a background run with no findings stays
quiet), a one-line summary, and `next` or `stop` when the timing should change. To stop or change the loop,
use `loop_manage` (`pause`, `delete`, `gate`), or edit its `.pi/loop.json` if it is declared there.
Don't just ignore the loop.
