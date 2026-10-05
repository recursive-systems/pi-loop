# pi-loop

Recurring prompts for the [Pi](https://pi.dev) coding agent. A loop re-sends a prompt to
*the same session* on a schedule, so each run shares the session's context and tools. It's
like Claude Code's `/loop`, with a few more features:

- **Daily times that follow daylight saving** (`at 07:30` in a zone you choose).
- **Gates:** a script in your project decides, each time a loop comes due, whether the model
  wakes at all. Check often and cheaply, and only spend a model turn when there's something to do.
- **Loops survive restarts** (`.pi/loops.json`), and one session owns a project's loops.
- **A countdown in [Herdr](https://herdr.dev)'s sidebar** when Pi runs in a Herdr pane.

## Install

```bash
pi install git:github.com/recursive-systems/pi-loop@v0.1.0       # for you, in every project
pi install -l git:github.com/recursive-systems/pi-loop@v0.1.0    # for this project (.pi/settings.json)
```

Try it without installing: `pi -e git:github.com/recursive-systems/pi-loop`.

## Use

```
/loop [interval] <prompt>          interval 5m | 2h | 1d (default 10m), or `at 07:30 [Area/City]` (daily)
/loop                              list
/loop rm|pause|resume|run <id>     only when <id> is an existing loop; otherwise it is a prompt
/loop test <id>                    run the loop's gate once and show its decision; never wakes
/loop clear
```

The model gets the same verbs through the `loop_manage` tool, so "every weekday at 7:30,
summarize the open pull requests" works in plain words.

## Behaviour

- A due loop is sent as a user message (`deliverAs: "followUp"`): if the session is idle, a
  turn starts now; if it is busy, after the current turn. One loop fires per 15 s tick.
- Each run starts with a header line: `[loop <id> · <schedule> · fire #N[ · <reason>][ · gate: <reason>]]`.
  It is one line and ends at its closing `]`. Other extensions may rely on its shape to
  recognise loop turns, so it changes only in a major version.
- Loops live in `.pi/loops.json` (mode 0600) and come back on session start. A loop that came
  due while no session was running fires once on start (`catchUp: latest`) if it is daily or
  at least 1 h; shorter loops just realign.
- One session owns a project's loops (`.pi/loops.lock`, by pid). Another session in the same
  directory sees them read-only and takes over when the owner's process is gone.
- Loops fire only while a Pi session is open in the project. Anything that must never miss
  belongs in your system's scheduler (cron, launchd, systemd timers).
- A loop's output stays in the session. If the result should go somewhere else, say where in
  the prompt.
- A prompt that is a prompt template (`/check`) is expanded by the loop from the template file
  each time it fires: an edited template takes effect without `/reload`, and the header and
  gate context reach the model intact. The file is the one Pi loaded for that name, else
  `.pi/prompts/<name>.md`. Skill and extension commands still lead the message for Pi to
  dispatch, with the header after them.

Add these to your `.gitignore`:

```
.pi/loops.json
.pi/loops.lock
.pi/loops.log.jsonl*
.pi/loop-state/
```

## Time zones

`at` loops (and whole-day intervals, below) are wall-clock times in a zone and follow daylight saving: `at 07:30`
in `America/Chicago` is 12:30Z in CDT and 13:30Z in CST. The zone is, first match:

1. the loop's own zone: `/loop at 07:30 Europe/London <prompt>` or `loop_manage` `timezone`;
2. `loop.timezone` in the project's `.pi/settings.json`;
3. `loop.timezone` in `<agent-dir>/settings.json` (useful on servers that run on UTC);
4. the machine's zone.

```json
{ "loop": { "timezone": "America/Chicago" } }
```

Loops without their own zone follow the setting; changing it re-derives their
next fire time on the next `/loop`, tool call or session start. `/loop` lists the
default zone and where it came from. An invalid name warns and falls back to the
machine's zone. Whole-day intervals (`every 1d`, `every 7d`) are zoned too: they step
calendar days and keep the wall time they were created at, so a daily loop made
at 15:43 CT stays at 15:43 CT across DST. Sub-day intervals (`10m`, `2h`) are a
plain fixed grid and ignore zones.

DST edges: a time skipped by spring-forward (02:30) fires just after the gap
(03:30); a time repeated by fall-back (01:30) fires once, the first time.

## Countdown in Herdr

Inside a Herdr pane (TUI sessions only, and only the session that owns the
loops), the extension reports display-only pane tokens every 15 s tick:

| token | value |
|---|---|
| `$loop` | `○ judge in 2h05m` · `◔ judge in 3m` (≤ 5 min) · `● judge queued` / `● judge running` · `◌ 2 paused` |
| `$loop_state` | `waiting`, `soon`, `queued`, `running`, `paused` |
| `$loop_in` | seconds to the next fire, for numeric rules; absent otherwise |

Minutes round up, so it never reads `0m` before firing. Tokens carry a 90 s TTL
refreshed while the session lives and are cleared when the last loop goes or the
session ends, so a dead session's countdown disappears instead of freezing. Pi's
own status line shows the same thing with the clock time: `next judge 07:30 CDT (in 9h12m)`.

Herdr renders nothing until the sidebar asks for the token. Add this to your Herdr
config (`~/.config/herdr/config.toml`) and run `herdr server reload-config`:

```toml
[ui.sidebar.agents.rows_by_agent]
pi = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", { token = "$loop", dim = true, rules = [
    { starts_with = "◔", fg = "#f9e2af", dim = false, bold = true },
    { starts_with = "●", fg = "#89b4fa", dim = false },
  ] }],
]
```

That is Herdr's default Agent layout with the next loop beside the agent name:
dim while waiting, yellow in the last five minutes, blue while its turn runs.
Pi panes without loops look exactly as before (missing tokens vanish with their
separator). If you already customise `ui.sidebar.agents.rows`, add `"$loop"`
there instead.

## Gates: deciding whether to wake the model

A loop can carry a **gate**: an executable in the project that runs when the
loop is due and decides whether this fire becomes a model turn. It lets a session
*check* often and cheaply (plain code, or a small model call) and *wake*
only when there is something to do.

```text
loop_manage create  every=5m prompt=/check gate=.pi/gates/check maxSleep=12h
loop_manage gate    id=<loop> gate=.pi/gates/check [maxSleep=12h] [gateTimeout=90s]   # set or change
loop_manage gate    id=<loop> gate=""                                                  # remove
/loop test <id>     (or loop_manage test)   run the gate once and show its decision; never wakes
/loop run <id>      wake now; bypasses the gate
```

The gate prints one JSON line (earlier stdout lines are ignored):

| `action` | effect |
|---|---|
| `skip` | no model turn; the loop waits for its next slot |
| `wake` | the prompt is sent with `· gate: <reason>` in its header (kept on one line: newlines in the reason become spaces) and `context` (≤ 4 KB) in a `<gate-context>` block |
| `defer` | run the gate again after `retryIn` (`30s`, `2m`; min 15 s), e.g. to confirm a failure |

It runs without a shell, cwd = the project, with `LOOP_ID`, `LOOP_PROMPT`,
`LOOP_LAST_WOKE_AT`, `LOOP_STATE_DIR` and, on a `/loop test` run only, `LOOP_TEST=1`
(a gate that records its own wakes should decide without recording then) (`.pi/loop-state/<id>/`, for the gate's
own memory such as the previous observation). It also gets the owning session's
`PI_SESSION_ID` and `PI_SESSION_FILE` (the same values Pi's bash tool exposes; the
file only when the session is saved), on due and `/loop test` runs alike, so a
gate can act on behalf of its session. Values Pi itself inherited
(from a parent session that launched it) are dropped, never passed on. A non-zero exit, a timeout
(default 60 s) or no JSON is a gate error and **wakes** the model, with the error
as the reason, so a broken gate cannot keep a session asleep. It wakes **once**:
while the gate keeps failing, later errors are logged as skips and the model is
reminded at most every 6 h (`still failing: N errors in a row`); the first
successful run resets this, so a broken gate on a 2-minute loop cannot flood
the session either. `gateOnError=skip` (create or gate) makes errors skip
instead; `/loop` shows the current error streak. `maxSleep` wakes the
model without asking the gate once that long has passed since the last wake.
The path must be a file inside the project; keep gates committed next to the
loop's prompt. Every decision is appended to `.pi/loops.log.jsonl` (rotated at
1 MB); `/loop` shows each gate's last decision. Gitignore `.pi/loops.log.jsonl*`
and `.pi/loop-state/` with the loops file.

## Cost to keep in mind

Every fire is a turn in this session's context. Keep short-interval prompts
terse ("reply `ok` unless …") and let daily prompts hand heavy work elsewhere.


## Tests

The tests run the real `pi` binary in RPC mode with this extension loaded, in a throwaway
project. They use no mocks: loops are made with the real `/loop` command, fire on the real
tick, run real gate scripts, and are checked through Pi's own events and the files the
extension writes. With `FIREWORKS_API_KEY` (or `FIREWORKS_API_KEY_FILE`) set, one more test
runs a woken loop through a real Fireworks model to the end of its turn.

```bash
npm install -g @earendil-works/pi-coding-agent   # if pi isn't installed
npm test
```

## License

MIT
