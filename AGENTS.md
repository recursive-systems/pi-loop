# pi-loop

A Pi extension: `/loop` and `loop_manage` schedule prompts in background forks by default.
Foreground execution requires explicit `--foreground` or `run: "foreground"`. Saved loops with
no mode migrate to forks on load. Optional gates decide whether a due loop wakes the model.

- `index.ts` holds the extension: commands, the tool, the tick and persistence. `lock.ts` is the
  one-owner-per-folder lock (an OS lock held by a small Perl helper; hosts use it too). `schedule.ts`
  holds intervals, daily times and DST. `gate.ts` runs gates. `models.ts` holds model fallback
  (lists, held-back models, the optional check command). `prompt.ts` builds a fire's
  message. `background.ts` runs a loop's turn in a child Pi over RPC (fork, thread or fresh) and
  `view.ts` is the loops view. `liveness.ts` is explicitly loaded in each RPC child: it implements the
  optional session-liveness v1 host contract and sends only busy/idle/error, so a settled turn with
  detached work or queued completions is not mistaken for a completed loop. Background runs and the folder lock live process-wide (`shared` in
  `index.ts`), because Pi rebuilds extensions on every session switch. Every folder-lock acquisition
  path must attach the live instance and drain pending callbacks; do not special-case only startup.
- `lifecycle.ts` owns the generic private registration/append-only metadata feed; see `LIFECYCLE.md`.
  Preserve distinct attempt/evaluation/incarnation identities, metadata-only projection, fsync/atomic
  registration and explicit gaps. Never put prompts, asks, reasons, reports, child errors, model data
  or credentials in it. Source publication is not host adoption or exactly-once effects.
- What an agent using pi-loop knows comes in three layers. Keep each short and consistent with the others:
  1. Always in context: `loop_manage`'s description, `promptSnippet` and `promptGuidelines` in `index.ts`.
  2. On demand: the skill `skills/pi-loop/SKILL.md` (setting up loops, writing gates).
  3. Just in time: hints in `loop_manage`'s results (duplicate loop, no gate on a frequent loop).
- Care for the surrounding design, preserve current writers and keep changes focused and reversible.
  Do not add, maintain or run unit-test suites. Build/static checks must be measured under 60 seconds.
  Temporary checks are minimal and ephemeral, never required build/deploy gates.
- Optional nonblocking end-to-end checks run the real `pi` binary with no mocks (`npm test`): they
  drive Pi the way an agent or user does, never unit tests or stand-ins for Pi or a model. A test that can't reach a real piece
  (no model key) is skipped with the reason, not faked.
  Live models require explicit PI_E2E_PROVIDER and PI_E2E_MODEL (see README); never silently choose
  a paid provider. Start with one selected case and run sequentially. Context-layer changes need the
  cases checking that a real agent uses the package correctly.
- Pi supplies `@earendil-works/*` and `typebox`: keep them optional peer dependencies, never installed
  with the package (a git install runs `npm install`).
- No terminal multiplexer or other host is assumed: everything works in plain Pi.
- A host (a scheduler that embeds this extension per folder) passes a context
  with `mode: "host"`, its own `isIdle`/`hasPendingMessages`, and runs the turns it is sent through
  `sendUserMessage`, whose options carry `loop: { id, fire, rev }` (Pi ignores it). Intent is saved
  before dispatch, but the counter is committed only after `sendUserMessage` returns. An ambiguous
  exception/crash before that commit now pauses rather than automatically repeating it. A fire moves
  on to a fallback model only when the failed attempt provably did nothing (`Run.failedBeforeWork`, or
  a child that never got the prompt) and failed for want of its model (`Unavailable` in `index.ts`);
  keep both strict. Other failures must stay visible as failures. If explicitly
  retried after reconciliation, a host must treat the same id/fire as the same occurrence. Preserve
  that contract, folder locks, kept wakes and draining gates at shutdown.
- The `[loop <id> · … ]` header line is a public contract. Change it only in a major version. So are
  the `pi.events` channels (`statusbar:*`, `loop:state` v1 and `loop:ready`): hosts such as
  multiplexers adapt to them in their own extensions, never here.

## Writing for people

- The README is for a person deciding in seconds whether this is worth their time. Lead with
  what it does and why it matters, keep only what they need to start, and cut anything else.
- Keep this file minimal: only what an agent needs to work here.
- Readers can be anywhere in the world. Don't assume a time zone, place, language or setup;
  where an example needs a zone, use a neutral one and say the default is theirs.
- Keep it generic: nothing specific to any one user, company or setup.
