# pi-loop

A Pi extension: `/loop` and the `loop_manage` tool re-send a prompt to the same session on a
schedule. Optional gate scripts decide whether a due loop wakes the model.

- `index.ts` holds the extension: commands, the tool, the tick and persistence. `schedule.ts`
  holds intervals, daily times and DST. `gate.ts` runs gates. `prompt.ts` builds a fire's
  message. `herdr.ts` holds the Herdr countdown tokens.
- What an agent using pi-loop knows comes in three layers. Keep each short and consistent with the others:
  1. Always in context: `loop_manage`'s description, `promptSnippet` and `promptGuidelines` in `index.ts`.
  2. On demand: the skill `skills/pi-loop/SKILL.md` (setting up loops, writing gates).
  3. Just in time: hints in `loop_manage`'s results (duplicate loop, no gate on a frequent loop).
- Tests run the real `pi` binary with no mocks (`npm test`). Add end-to-end tests, never unit tests.
  With a Fireworks key, two of them check that a real agent uses the package correctly; when you change
  the context layers, run those.
- The `[loop <id> · … ]` header line is a public contract. Change it only in a major version.
- Keep it generic: nothing specific to any one user, company or setup.
