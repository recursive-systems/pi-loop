# pi-loop

A Pi extension: `/loop` and the `loop_manage` tool re-send a prompt to the same session on a
schedule. Optional gate scripts decide whether a due loop wakes the model.

- `index.ts` holds the extension: commands, the tool, the tick and persistence. `schedule.ts`
  holds intervals, daily times and DST. `gate.ts` runs gates. `prompt.ts` builds a fire's
  message. `herdr.ts` holds the Herdr countdown tokens.
- Tests run the real `pi` binary with no mocks (`npm test`). Add end-to-end tests, never unit tests.
- The `[loop <id> · … ]` header line is a public contract. Change it only in a major version.
- Keep it generic: nothing specific to any one user, company or setup.
