# pi-loop

**Put your [Pi](https://pi.dev) agent on a schedule.**

```
/loop 30m check CI and fix anything red
/loop at 07:30 summarize what changed overnight
```

Loops run **in the background by default**, on a copy of your conversation. The job knows what
you said without taking over your chat. Use `--foreground` only when you want checks in the
conversation itself:

```
/loop 15m check the deploy and tell me if anything changed
/loop 1h --foreground review our progress here
```

- **Gates keep it cheap.** A small script runs first and decides whether there's anything worth
  waking the model for. No news, no tokens spent.
- **Daily times follow daylight saving** in whatever time zone you set, or your machine's.
- **Loops survive restarts.** They're saved in `.pi/loops.json`.
- **Upcoming on main: supervisors can follow every registered origin.** A private, durable metadata feed retains
  startup failures and lifecycle outcomes even after the next run replaces `lastRun`.
- **Quiet unless there's news.** A background run says what it found with `loop_report`; a run with
  nothing to report leaves no trace in your conversation.
- **The agent can watch something for you.** A loop can pick its own next time (`auto`: every 2 minutes
  while a deploy runs, an hour when it's quiet) and end itself when it's done. Loops made on the fly end
  after 7 days unless they say otherwise.
- **You can ask in plain words**: "every morning at 9, triage new issues" works too. The package
  ships a skill that teaches the agent to gate frequent loops and keep instructions in a template.

## Install

```bash
pi install git:github.com/recursive-systems/pi-loop@v0.13.1
```

Add `-l` to install it for one project only.

## Commands

```
/loop [5m|2h|1d|auto] <prompt>        repeat every interval (default 10m), or when each run says
/loop at 07:30 [Area/City] <prompt>   daily, in that zone or your default
      --fork | --thread | --fresh     background mode (default: fork)
      --model a/x[,b/y]              its model, then fallbacks (default: yours)
      --foreground                   run in this conversation instead
      --for 2d | --until <time>       how long it lives (default 7 days)
/loop                         the loops view: every loop, its runs, watch and steer them
/loop run|pause|resume|rm <id>
/loop test <id>               run the gate once, without waking the model
/loop watch|steer|take|open|cancel <id>, /loop leave|done   background runs, below
```

## What reaches you

A run tells you only what needs you. After a background run reports, a classifier model (TypeSafe's
Jev by default, through Pi's model registry) reads the report, the run's `ask` and what was put in
front of you before, and decides:

- **needs you**: a decision, approval or action only you can take, new or changed. It lights the
  status line with the ask itself and posts it in the conversation.
- **worth knowing**: shown, muted, in the loops view only.
- **routine**: recorded, nothing more.

A failed run, or one that asked you something, always needs you. A successful report does not:
the classifier cannot turn its text into an ask. Without the run's own `ask`, it is worth knowing
at most. To dismiss what a loop surfaced,
press `d` in the loops view, run `/loop dismiss <id>`, or tell the agent it's handled (it calls
`loop_manage` `dismiss`); the judge then treats a repeat of it as routine. Set the judge in settings
with `{"loop": {"judge": "<provider>/<id>"}}`, or `"off"`; without one, a run's own `ask` decides.

```
loops ●●●●●●
loops ●●✕●●● Reconnect Stripe in Executor
loops ●●✕●✕● Reconnect Stripe in Executor +1
```

`●` quiet, `◉` running, `✕` needs you, `○` late or waiting, `◌` paused. The loops view (`/loop`)
shows the same symbols, the reason beside each, and the key.

A status bar extension can show this line as one of its rows: when it emits `statusbar:ready` on
`pi.events`, pi-loop sends `statusbar:item` (`{ id: "loops", order, render(theme, width), open(ctx) }`,
`open` shows the loops view) instead of setting a footer status.

Other extensions can follow the loops too, to show them in a terminal multiplexer's sidebar or send a
notification, without pi-loop knowing about either. Each time the loops change, pi-loop emits
`loop:state` on `pi.events`:

```js
{ v: 1, loops: [{ id: "backup", state: "needs", ask: "Reconnect the storage account", nextAt: 1767225600000 }] }
```

`state` is a symbol's name (`quiet`, `running`, `needs`, `late`, `paused`), `ask` comes only with
`needs`, and `nextAt` is in epoch milliseconds. A session that doesn't own the folder's loops sends
an empty list. Emit `loop:ready` to get the current state again, for example when your extension starts.

## Background runs

Loops do their work in a separate Pi beside your conversation:

- `fork` (default): a copy of your conversation as it is when the loop fires, so it knows what you've been doing.
- `thread`: the loop's own conversation, continued every run.
- `fresh`: a new conversation each run.

The same default applies to `/loop`, `loop_manage create` and `.pi/loop.json`. Set `run` to
`"foreground"` (or pass `/loop --foreground`) to run in the conversation instead. Before the first
conversation is saved, a fork runs fresh because there is no saved conversation to copy.

A copied conversation may need compaction before Pi accepts the loop prompt. Compaction pauses the
normal 30-second prompt-acceptance clock, with a ten-minute overall cap for that wait. A run is
counted only when Pi actually accepts its prompt.

**Upgrading to 0.11:** saved loops and declarations with no `run` mode become background forks
when loaded. Explicit `fork`, `thread` and `fresh` modes stay unchanged. To keep an old loop in
the conversation, stop its old Pi session, upgrade, then set `run: "foreground"` before starting
it again. Older versions do not understand that value. A mode edit in the new version waits for
that loop's active foreground or background turn to finish; it never cancels or duplicates it.

A run starts in the loop's own folder (the project, or its `dir`), so Pi gives it that folder's settings,
tools (`.pi/mcp.json`), prompt templates, data class and `AGENTS.md` files, as if you had started Pi
there. `model` (`provider/id` or `provider/id:thinking`) picks its model; otherwise it uses yours. A `fork` copies your conversation but acts from the
loop's folder too. You can't step into a run that works in another folder (Pi would move your session
there); watch and steer it instead. Trust each folder a run works in (a background run can't answer Pi's
trust question), and keep the machine's own pi-loop at 0.5 or later: an older one would run the folder's
loops itself, so such a run doesn't start.

**Fallback models.** Give `model` a list, first choice first, and a fire moves on to the next model
when one can't serve it:

```json
{"id": "triage", "prompt": "/triage", "at": "09:00", "run": "fresh", "model": ["provider-a/big:high", "provider-b/other"]}
```

A fire moves on only when its run did nothing (Pi started the prompt, every answer was a model error
with nothing in it, no tool ran) and the failure was about the model's availability: Pi judged the
error transient (overloaded, rate limited, a server or connection error), retried, and gave up; or
your check command lists the model. It also moves on, before sending anything, when the run's Pi
didn't start or lists no credentials for the provider. Any other failure, such as a context overflow
or a bad request, is recorded as failed as always. A quota error that Pi doesn't retry is only caught
through a check command.

A model that failed that way is held back for the folder's loops for 30 minutes (`loop.modelBackoff`),
doubling while it keeps failing (up to 8 times that), then tried first again: loops return to their
first choice on their own. The loops view, `/loop` and each run's record show its model, mark a
fallback and say why. `loop.fallbackModels` (a list) gives every background loop that names no model
fallbacks after yours, so a whole folder (or, in the agent's settings, a machine) can opt in at once;
a loop that names a model keeps exactly what it names, and `false` or `[]` in a project's settings
opts it out of the agent's list.

For a quota meter of your own, set `loop.modelCheck` to the path of an executable (no arguments in the
setting). It is called with the models as arguments and prints
`{"unavailable": ["provider/id"], "available": ["provider/id"]}`. A listed-unavailable model is skipped;
a listed-available one is tried even while held back; a model in neither list is one it doesn't track,
and its hold decides.

Before going back to a release without fallback, change model lists back to single strings: older
releases refuse a list declared in `.pi/loop.json`, and pass one saved by `loop_manage` to Pi as a
single comma-joined value, which fails.

Each run ends with `loop_report`: whether it found something, one line, and optionally when to run
next or to stop. Only reports that need you enter the conversation; other results stay in the loops
view, as described above.

A run stays alive while a compatible extension reports outstanding background work or a pending
completion notice. With pi-subagents (session-liveness v1 support), an async reader can finish and
wake the same run to process its answer. Report completion only after that processing, not after
launching the reader. This does not make arbitrary detached shell commands durable or external
side effects exactly once; cancelling a loop is not a promise to cancel its detached descendants.

From the loops view (`/loop`) you can watch a run live and type to steer it, or go into it (`t`, or
`/loop take <id>`): the run stops at its next step and your Pi switches into its conversation, a regular
session (`/loop open <id>` does the same for a finished run). `/loop leave` brings you back and lets it
carry on in the background; `/loop done` brings you back and ends it; leaving it any other way (`/new`,
`/resume`) counts as `/loop leave`. `loop.maxBackground` in settings limits how many run at once (default: no limit).

## Gates

A gate is an executable in your project. It prints one line of JSON:

```json
{"action": "skip", "reason": "no new commits"}
{"action": "wake", "reason": "2 failing jobs", "context": "build #812, lint #813"}
```

`skip` means no model turn. `wake` sends the prompt, along with the gate's reason and
context. `defer` asks again later (`"retryIn": "2m"`). A gate that crashes wakes the model
once, so a bug can't keep it asleep forever. The model attaches a gate with `loop_manage`
(`gate=.pi/gates/check`).

## Keeping loops cheap

Every wake is a full model turn, so the main saving is to wake less often. Patterns that work well
in a gate:

1. **Let code check facts first.** Run the health check, the diff or the API call, and compare
   it with the last run (keep state in `$LOOP_STATE_DIR`). If nothing changed, `skip`.
2. **Use a decision model for the fuzzy part.** When the question is about messy text ("is this
   failure the same incident?", "does this need a human today?"), ask a fast decision model a
   typed question and let code apply a threshold. That can be a System-1 classifier such as
   [TypeSafe's Jev](https://docs.typesafe.ai), or a small, cheap LLM asked for strict JSON. It
   costs a fraction of a turn, and your agent's model only wakes for the real work.
3. **Don't ask twice.** Cache each judgment by a hash of what was judged, so an unchanged item
   isn't paid for on every tick.
4. **Fail toward waking.** If the decision model is down, decide on the code checks alone. A gate
   that errors wakes the model anyway.
5. **Let the gate do the routine work.** A gate can collect and sort on every tick and wake the
   agent only once a day to act on the results.

Log each decision to `$LOOP_STATE_DIR` so you can tune the thresholds later.

## One session, several jobs

- **Loops never pile up.** A background loop has at most one run going at a time. An explicit
  foreground loop waits while the agent is busy and fires once when it's free, with its gate run
  then so the evidence is fresh. Among waiting foreground loops, the highest `priority` goes first.
- **Each job can have its own folder** with its gate, its prompt template and its instructions
  (`dir`, and `context: ["AGENTS.md"]` to attach them to that job's turns only).
- **Declare loops in files.** The project's `.pi/loop.json` defines its loops; edit the file to
  change them. Folders under the project aren't read: a folder's loops run in a session opened in
  that folder, so a session opened above it never picks them up too. `loop.folders` in the
  project's `.pi/settings.json` (`["../business"]`) adopts folders beside it (each with a `.pi` of its
  own): their own `.pi/loop.json` loops run here too, in the background. The session holds each adopted
  folder's lock, so a session opened in one of those folders is read-only instead of running its loops twice:

```json
{"loops": [{"id": "api-check", "prompt": "/check", "every": "5m", "gate": ".pi/gates/check", "context": ["AGENTS.md"]}]}
```

## Supervision (prepared for 0.12)

This section describes the upcoming source on `main`, not the tagged stable install above.
Source publication does not install or reload a running host.

Hosts register their project/adopted origins and write metadata-only lifecycle records under
`<agent-dir>/loop-hosts/`. No prompts, reports, gate reasons or credentials go there. Consumers
must authorize each source and treat stale hosts, reporting gaps and older loaded versions as
partial coverage—not proof of delivery or permission to repeat work. See [the v1 feed contract](LIFECYCLE.md).

A failed or lost child prompt acknowledgement may follow an already-executed command. That
loop now pauses for reconciliation instead of automatically retrying. Definite preparation or
child-start failures retain their existing retry behavior. This does not replace a job's own idempotency or native approvals.

## What a loop leaves behind

To see how a loop is doing (how often it woke for nothing, what it missed, what it costs), look at
what Pi already keeps, plus three things only pi-loop knows:

- **Each run is a Pi session.** It holds the conversation, its cost, and anything you said to the run.
  pi-loop adds a `pi-loop.run` entry (not in the model's context) saying why it ran:
  `{"loop": "disk", "fire": 4, "mode": "fresh", "by": "gate", "gate": {"reason": "free fell 6 GiB"}}`.
  `by` is `schedule`, `gate`, `heartbeat` (its `maxSleep`) or `manual`. Background runs are named
  `loop <id> #<fire>` in `/resume`.
- **`.pi/loops.log.jsonl`** has every gate decision, and a `fired` line for each run that started,
  with the run's session file and model; `fallback`, `model-unavailable` and `model-available` lines
  say when a run moved on to another model and why. Held-back models are in `.pi/loop-models.json`.
- **At a heartbeat** the model wakes without asking the gate. pi-loop asks the gate anyway, as a test,
  and logs its answer as a `shadow` line. A `skip` there followed by a run that found something is a
  miss the gate made.

What the gate measured is for the gate to keep, in `$LOOP_STATE_DIR`.

## Good to know

- Loops run only while a Pi session is open in the project. For anything that must never be
  missed, use cron.
- One session per project owns its loops, through an OS lock held by a small Perl helper (Perl is in
  the base system on macOS and Linux). Without Perl, loops can't run and the session says why. If a
  session loses the lock, it stops changing loops at once and takes them back once the lock is free.
- The default time zone is your machine's. Set another in `.pi/settings.json` with
  `{"loop": {"timezone": "<Area/City>"}}`, using any IANA name, such as `Asia/Tokyo`.
- Every run starts with `[loop <id> · <schedule> · fire #N]`, which you can rely on.

## Optional end-to-end checks

Outside the build, nonblocking and against the real `pi`, with no mocks: `npm test`.
Use light selected checks periodically; failures go to the owner, never a required release gate.

Live-model tests are opt-in: set `PI_E2E_PROVIDER` and `PI_E2E_MODEL` explicitly.
For an existing Pi gateway connection, also set `PI_E2E_MODELS_FILE` and
`PI_E2E_AUTH_FILE` to absolute paths to your Pi models and API-key auth files.
Pi reads authentication directly; credentials are not printed. Use synthetic test data only.
Without an explicit model selection, those tests skip. There is no automatic provider fallback.
Run one case first with Node's `--test-name-pattern`, then use `--test-concurrency=1`
to avoid parallel model load. The async handoff regression also needs `PI_E2E_SUBAGENTS`, an absolute
path to the installed real pi-subagents extension (`index.js`); it starts a harmless reader against
the selected model and checks that its native completion is processed once in the original loop.

MIT
