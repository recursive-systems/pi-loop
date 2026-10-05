# pi-loop

**Put your [Pi](https://pi.dev) agent on a schedule.**

```
/loop 30m check CI and fix anything red
/loop at 07:30 summarize what changed overnight
```

The prompt comes back to *the same session*, so the agent remembers what it did last time.

- **Gates keep it cheap.** A small script runs first and decides whether there's anything worth
  waking the model for. No news, no tokens spent.
- **Daily times follow daylight saving** in your time zone.
- **Loops survive restarts.** They're saved in `.pi/loops.json`.
- **You can ask in plain words**: "every morning at 9, triage new issues" works too.

## Install

```bash
pi install git:github.com/recursive-systems/pi-loop@v0.1.0
```

Add `-l` to install it for one project only.

## Commands

```
/loop [5m|2h|1d] <prompt>     repeat every interval (default 10m)
/loop at 07:30 [Zone] <prompt>   daily, e.g. at 07:30 Europe/London
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

## Good to know

- Loops run only while a Pi session is open in the project. For anything that must never be
  missed, use cron.
- The time zone comes from `{"loop": {"timezone": "America/Chicago"}}` in `.pi/settings.json`,
  or your machine's zone.
- In [Herdr](https://herdr.dev), the sidebar can show a countdown to the next loop: add the
  `$loop` token to your agent rows.
- Every run starts with `[loop <id> · <schedule> · fire #N]`, which you can rely on.

## Tests

End-to-end against the real `pi`, with no mocks: `npm test`. Set `FIREWORKS_API_KEY` to also run
a loop through a real model.

MIT
