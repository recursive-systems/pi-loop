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
pi install git:github.com/recursive-systems/pi-loop@v0.2.0
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

## Good to know

- Loops run only while a Pi session is open in the project. For anything that must never be
  missed, use cron.
- The default time zone is your machine's. Set another in `.pi/settings.json` with
  `{"loop": {"timezone": "<Area/City>"}}`, using any IANA name, such as `Asia/Tokyo`.
- In [Herdr](https://herdr.dev), the sidebar can show a countdown to the next loop: add the
  `$loop` token to your agent rows.
- Every run starts with `[loop <id> · <schedule> · fire #N]`, which you can rely on.

## Tests

End-to-end against the real `pi`, with no mocks: `npm test`. Set `FIREWORKS_API_KEY` to also run
a loop through a real model and check that a real agent sets loops up correctly.

MIT
