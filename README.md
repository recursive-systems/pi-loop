# pi-loop

**Put your [Pi](https://pi.dev) agent on a schedule.**

```
/loop 30m check CI and fix anything red
/loop at 07:30 summarize what changed overnight
```

The prompt comes back to *the same session*, so the agent remembers what it did last time.

- **Gates keep it cheap.** A small script runs first and decides whether there's anything worth
  waking the model for. No news, no tokens spent.
- **Daily times follow daylight saving** in whatever time zone you set, or your machine's.
- **Loops survive restarts.** They're saved in `.pi/loops.json`.
- **You can ask in plain words**: "every morning at 9, triage new issues" works too. The package
  ships a skill that teaches the agent to gate frequent loops and keep instructions in a template.

## Install

```bash
pi install git:github.com/recursive-systems/pi-loop@v0.3.1
```

Add `-l` to install it for one project only.

## Commands

```
/loop [5m|2h|1d] <prompt>     repeat every interval (default 10m)
/loop at 07:30 [Area/City] <prompt>   daily, in that zone or your default
/loop                         list
/loop run|pause|resume|rm <id>
/loop test <id>               run the gate once, without waking the model
```

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

- **Loops never pile up.** A loop that comes due while the agent is busy waits and fires once when
  it's free, with its gate run at that moment so the evidence is fresh. When several are waiting,
  the one with the highest `priority` goes first.
- **Each job can have its own folder** with its gate, its prompt template and its instructions
  (`dir`, and `context: ["AGENTS.md"]` to attach them to that job's turns only).
- **Declare loops in files.** A `.pi/loop.json` in the project, or in any folder directly under it,
  defines loops; edit the file to change them. Adding a folder adds a job:

```json
{"loops": [{"id": "api-check", "prompt": "/check", "every": "5m", "gate": ".pi/gates/check", "context": ["AGENTS.md"]}]}
```

## Running loops with no session open

[herdr-pi-loops](https://github.com/recursive-systems/herdr-pi-loops) is a Herdr plugin that runs
declared loops for you: each role folder gets a pane, Pi starts there only for a turn, and one
dashboard shows every loop. A scheduler like it embeds this extension with `mode: "host"` in the
context it passes, and then serves only that folder's own `.pi/loop.json`.

## Good to know

- Loops run only while a Pi session is open in the project. For anything that must never be
  missed, use cron.
- One session per project owns its loops, through an OS lock held by a small Perl helper (Perl is in
  the base system on macOS and Linux). Without Perl, loops can't run and the session says why.
- The default time zone is your machine's. Set another in `.pi/settings.json` with
  `{"loop": {"timezone": "<Area/City>"}}`, using any IANA name, such as `Asia/Tokyo`.
- In [Herdr](https://herdr.dev), the sidebar can show a countdown to the next loop: add the
  `$loop` token to your agent rows.
- Every run starts with `[loop <id> · <schedule> · fire #N]`, which you can rely on.

## Tests

End-to-end against the real `pi`, with no mocks: `npm test`.

Live-model tests are opt-in: set `PI_E2E_PROVIDER` and `PI_E2E_MODEL` explicitly.
For an existing Pi gateway connection, also set `PI_E2E_MODELS_FILE` and
`PI_E2E_AUTH_FILE` to absolute paths to your Pi models and API-key auth files.
Pi reads authentication directly; credentials are not printed. Use synthetic test data only.
Without an explicit model selection, those tests skip. There is no automatic provider fallback.
Run one case first with Node's `--test-name-pattern`, then use `--test-concurrency=1`
to avoid parallel model load.

MIT
