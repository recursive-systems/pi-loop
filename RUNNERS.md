# Runners (v1)

A runner is how a background loop's run is started. Two are built in:

| Runner | The run is | You see it |
| --- | --- | --- |
| `rpc` (default) | a hidden child Pi that pi-loop drives over a pipe | `/loop watch`, or a watcher terminal (pi-loop-herdr) |
| `pi` | an ordinary interactive Pi in a terminal | the terminal itself: type straight into it |

Choose one per loop (`runner` in `loop_manage` or `.pi/loop.json`, `/loop --runner pi ...`) or for every loop
that doesn't say (`loop.runner` in the project's or agent's `settings.json`). Without either, nothing changes.

Any other agent can be a runner by describing it in settings. pi-loop's core knows nothing about it.

## Where the terminal comes from

pi-loop never opens terminals. When a terminal run starts it emits `loop:terminal` on `pi.events`:

```ts
{ v: 1, op: "open", loop, fire, attemptId, runner, name, title, description, project, cwd,
  argv,                 // start exactly this, in cwd: a script in the run's private channel folder
  ready,                // a Promise: start it after this resolves
  inherit,              // push the variables your terminal sets for its programs (e.g. "HC_TERMINAL_ID", "TMUX*")
  provide(handle) }     // call synchronously with a Promise of { id, attach?, close?(), send?(text) }
{ v: 1, op: "probe", here() }   // call here() if you supply terminals
```

pi-loop-herdr supplies Herdr terminals. They outlive the loop's session, so a restart picks the run up rather than losing it. With no provider, a terminal runner's run fails at once and says so (`nothing here supplies one`); pi-loop does not quietly fall back to a hidden child.

## The channel: how the loop knows what the run is doing

Each attempt gets a private folder, `<loop folder>/.pi/loop-state/<id>/runs/<attemptId>/` (0700), passed to
the run as `PI_LOOP_CHANNEL`. The run appends events to `events.jsonl`; the loop appends commands to
`commands.jsonl`, which only a runner with a companion reads. The run's script (`run.sh`) loads the run's
environment from `env.sh`, deletes that file, records its pid and `exec`s the agent.

| Event | Meaning | Sent by Pi's companion | Sent by a command runner's hooks |
| --- | --- | --- | --- |
| `started` | the agent is up | session_start | session start hook |
| `accepted` / `prompt` | it took the loop's prompt (**counts as fired**) | its first agent_start after the prompt | prompt-submit hook |
| `working` / `idle` | a turn started / it settled | agent_start / agent_settled | `idle` from the stop hook |
| `answer` | an answer ended (`stop=error` for a model error; `model`) | message_end | optional |
| `tool` / `activity` | it did work / is still making progress | tool and stream events | post-tool hook |
| `background` | it still owns detached work after settling | session-liveness v1 | — |
| `dialog` / `dialog_end` | it waits on a person | ui_prompt_start/end | notification hook |
| `keys` / `owner` | someone typed into it | terminal input | — |
| `exit` | it is closing normally | session_shutdown | session end hook |
| `spawned` / `exited` | its process started / ended | run.sh | run.sh |

The report is the same file a hidden run writes (`PI_LOOP_REPORT`). Pi writes it with the `loop_report` tool.
Any other agent is told to run `node <pi-loop>/bin/loop-run.mjs report --findings false --summary "..."`.

## What holds for every terminal runner

- **Fired only once accepted.** The fire counts when `accepted`/`prompt` arrives. Before that, a refusal (no
  model, no credentials) leaves it unfired, and a silence (no sign within 30s, or 10m while it shows life) is
  recorded failed with acceptance unknown, and the loop pauses, as for a hidden run.
- **A run that hangs** (no event at all while working for `stallAfter`, default 2h; typing into it counts as
  life) is stopped and recorded failed.
- **A run that crashes or is closed by hand** while working is recorded failed. Its pid is checked every
  250ms, and run.sh records the exit.
- **A dialog nobody answers** for `dialogWait` (default 5m; a key pressed resets it) is declined in Pi, or for
  a runner without a companion the run is stopped. Either way the run says it needed you.
- **After a run is recorded** its session stays open in its terminal for the owner to read or carry on. It closes after `keepOpen` (default 30m) with no keys, or at once with `keepOpen: false`. A thread's next fire continues in that same open session.
- **The loop's session restarting** leaves terminal runs alone. The next owner picks each one up from its record and its channel (replaying it, so a run that finished meanwhile is recorded from what it said), follows it, and never starts it again.
- **Model fallback** works where the runner reports models: `answer` events with `stop=error` and no content, the same error answered twice (Pi retried and gave up), or the check command. A runner with `model` args gets the next model in a new terminal.
- **fork, thread, fresh.** `pi` expresses all three. A command runner lists the modes it can express. Others run fresh, and pi-loop says so each time.

## Describing another agent

```jsonc
// .pi/settings.json or <agent-dir>/settings.json
{ "loop": { "runners": { "claude": {
  "command": ["claude", "--settings", "{channel}/settings.json", "--permission-mode", "acceptEdits"],
  "prompt": "argv", "promptArgs": ["{prompt}"],
  "model": ["--model", "{model}"],
  "modes": { "fresh": [], "thread": ["--resume", "{thread}"] },
  "files": { "settings.json": { "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "{hook} event started" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "{hook} event prompt" }] }],
    "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "{hook} event tool" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "{hook} event dialog" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "{hook} event idle" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "{hook} event exit" }] }]
  } } },
  "stallAfter": "2h", "dialogWait": "5m", "keepOpen": "30m"
} } } }
```

Tokens: `{channel}`, `{prompt}`, `{model}`, `{thinking}`, `{thread}` (the agent's own session id from its last
run, as its hooks reported it in `session_id`), `{hook}` (the `loop-run.mjs` command), `{cwd}`. `prompt:
"channel"` (needs `commands: true`) is for an agent with a companion that reads `commands.jsonl` as Pi's does.

The example above is how Claude Code would be described. It has not been run: the test suite proves the
contract with a stand-in agent (`tests/fixtures/fake-agent.mjs`) that calls the same hooks. Codex is described
the same way, through its hooks (session start, prompt submit, post-tool, stop) set in its config.
