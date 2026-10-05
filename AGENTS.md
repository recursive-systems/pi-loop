# pi-loop

A Pi extension: `/loop` and the `loop_manage` tool re-send a prompt to the same session on a
schedule. Optional gate scripts decide whether a due loop wakes the model.

- `index.ts` holds the extension: commands, the tool, the tick and persistence. `lock.ts` is the
  one-owner-per-folder lock (an OS lock held by a small Perl helper; hosts use it too). `schedule.ts`
  holds intervals, daily times and DST. `gate.ts` runs gates. `prompt.ts` builds a fire's
  message. `herdr.ts` holds the Herdr countdown tokens.
- What an agent using pi-loop knows comes in three layers. Keep each short and consistent with the others:
  1. Always in context: `loop_manage`'s description, `promptSnippet` and `promptGuidelines` in `index.ts`.
  2. On demand: the skill `skills/pi-loop/SKILL.md` (setting up loops, writing gates).
  3. Just in time: hints in `loop_manage`'s results (duplicate loop, no gate on a frequent loop).
- Tests run the real `pi` binary with no mocks (`npm test`): end-to-end tests that drive Pi the way an
  agent or user does, never unit tests or stand-ins for Pi or a model. A test that can't reach a real piece
  (no model key) is skipped with the reason, not faked.
  Live models require explicit PI_E2E_PROVIDER and PI_E2E_MODEL (see README); never silently choose
  a paid provider. Start with one selected case and run sequentially. Context-layer changes need the
  cases checking that a real agent uses the package correctly.
- Pi supplies `@earendil-works/*` and `typebox`: keep them optional peer dependencies, never installed
  with the package (a git install runs `npm install`).
- A host (a scheduler that embeds this extension per folder, such as herdr-pi-loops) passes a context
  with `mode: "host"`, its own `isIdle`/`hasPendingMessages`, and runs the turns it is sent through
  `sendUserMessage`, whose options carry `loop: { id, fire, rev }` (Pi ignores it). A fire is recorded
  only after `sendUserMessage` returns, so a crash re-sends the same id and fire: a host must treat
  that as the same occurrence. Keep that contract working: the lock, kept wakes and draining gates at
  shutdown are what make it safe.
- The `[loop <id> · … ]` header line is a public contract. Change it only in a major version.

## Writing for people

- The README is for a person deciding in seconds whether this is worth their time. Lead with
  what it does and why it matters, keep only what they need to start, and cut anything else.
- Keep this file minimal: only what an agent needs to work here.
- Readers can be anywhere in the world. Don't assume a time zone, place, language or setup;
  where an example needs a zone, use a neutral one and say the default is theirs.
- Keep it generic: nothing specific to any one user, company or setup.
