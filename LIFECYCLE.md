# Local lifecycle feed (v1)

From 0.12, scheduler hosts register under `<agent-dir>/loop-hosts/hosts/*.json` and append
metadata to the listed `streams/*.jsonl`. The agent directory defaults to `~/.pi/agent`.
No extra daemon, watcher, network request or model is involved. Registration updates when
ownership/definitions change and at least once per minute while the existing scheduler ticks.
Background children do not register as schedulers.

A supervisor can discover registered origins without scanning arbitrary project directories.
Discovery is **not permission to read a project's reports or conversations**. Authorize each
origin separately. Keep product-specific case handling and notifications outside this package.

## Registration

Each private, atomic/fsynced registration contains:

- `v: 1`, random `hostId`, `pid`, package `version`, canonical `schedulerCwd`;
- `startedAt`, `observedAt` (epoch ms), current `sessionId` and
  `state: owner | readonly | switching | stopped`, `untrackedActive` (older active children);
- `loops`: `id`, `incarnation` (persisted creation time), definition `revision`, declaration
  `folder`, execution `workDir`, `owned`, `paused`, `mode`, `nextAt`, optional `expiresAt`;
- ordered `streams: [{file, firstSequence}]`, allocated `sequence`, last `committedSequence`,
  cumulative `reportingFailures`, `gaps`, and optional last `errorCode` (never an error message).

Only the actual folder-lock holder reports owned origins. Adopted origins require their own
folder locks. Read-only hosts do not claim ownership; registrations are not authority to resume
or revive a loop. Host ids and journals survive session replacement within a process/version.
Quitting records `stopped`; abrupt death can only leave a stale registration. A PID or recent
heartbeat alone does not prove an origin is still owned: reconcile current locks, incarnation,
paused/expiry state, host/version and freshness at the source.

## Records

Every complete newline-delimited record has `v: 1`, unique `eventId`, `hostId`, monotonic
per-host `sequence`, `at`, `schedulerCwd`, optional parent `sessionId`, and:

```json
{"event":"terminal","loop":{"id":"check","incarnation":1760000000000,"revision":1,"folder":"/project","workDir":"/project"},"attemptId":"opaque-uuid","fire":3,"mode":"fresh","status":"done","acceptance":"accepted","findings":false,"hasAsk":false,"needsPermission":false}
```

The example omits the common envelope fields. Optional fields depend on the event:

| Event | Meaning |
| --- | --- |
| `attempt` | Startup/resume attempted; `attemptId`, proposed `fire`, `mode`, `by` |
| `accepted` | Child RPC actually acknowledged the prompt; optional `session` |
| `terminal` | Framework outcome; `status`, acceptance and report **booleans**, not success of an external operation |
| `gate` | One real normal gate evaluation; unique `evaluationId`, raw `action`, `error` boolean |
| `dispatch_blocked` | Invalid execution folder prevented dispatch; no accepted fire |
| `handoff` | Owner took over a child; not completion or failure |
| `interruption` | Shutdown/recovery/unobserved foreground dispatch; effects remain unknown |
| `foreground_queued` | Transport returned, but transcript entry has not proved acceptance |
| `foreground_running` | Matching loop message entered the foreground transcript |

`by` is `schedule | gate | heartbeat | manual | resume | leave`. A proposed fire can be reused
after a definite startup refusal, so **fire number alone is not an attempt identity**. A loop with
fallback models also reuses it after an accepted attempt that provably did nothing (every answer a
model error with no content, no tool run) because its model was unavailable: that attempt's
`terminal` is `failed`, then a new `attempt` follows for the same fire on the next model. A manual
resume/leave gets a new attempt id even on the same conversation/fire. Old records without
attempt ids remain explicitly older/untracked evidence, never reconstructed as new attempts.
Gate events preserve the evaluated definition even if it changed meanwhile. `LOOP_TEST`/manual
gate tests, heartbeat shadows, and synthetic max-sleep wakes are not normal gate evaluations.
Backoff may change a gate's effective action; this feed records its raw evaluation, not delivery.

Background terminal statuses are `done | failed | cancelled`; an interruption is an observation,
not proof of rollback. Foreground settlement uses `settled | cancelled`, not an inferred successful
model/tool/business result. Child extension errors and final model error/abort events produce a
failed framework record even when RPC acknowledged the command. A recovered model retry does
not retain an earlier provisional model failure. Only the fact, never the diagnostic, enters
the feed. A refused or missing report never proves an external operation did
not happen. Report flags cannot establish repair, consent, billing or device delivery.

## Durability, privacy and gaps

Files are private (0600, directories 0700). Each journal append is fsynced before its registration
is updated. Registrations use unique temporary files, fsync and atomic replacement. Journals are
append-only and not automatically pruned. There is no raw prompt, ask, gate reason/context,
summary, child diagnostic, tool result, client payload, model/provider or credential data.
Paths and loop/session ids are local metadata and can still be sensitive.

Track source identity, sequence and byte boundaries. Read only complete newline-terminated
records. Deduplicate by `(hostId,eventId)`, reconcile attempts by `attemptId`, and persist intake
before advancing a consumer cursor. Do not treat a source registration, cursor or file size as
remote delivery proof. Existing report files remain the source for separately authorized content.

A reporting error increments counters and emits a bounded UI warning and `loop:lifecycle:error`
(v1, hostId, errno code only). These counters/last code are **historical**, not a claim of a current
outage. A torn/changed/missing stream is never truncated or rewritten: subsequent writes use a new
segment and retain a gap. Missing sequences, incomplete tails, I/O failures, dead/stale hosts or
missing terminal observations mean **partial/unknown coverage**, not invented success or loss.
A crash between append and registration can leave an unlisted final segment; do not certify
complete coverage from the manifest alone. Reconcile retained source evidence before retrying.

This is local lifecycle evidence, **not exactly-once execution, an independent host supervisor,
backup or a replacement for runtime safeguards**. A prompt acknowledgement timeout can conceal
an already-executed command. A negative response is not a rollback guarantee either.
Such a background startup now pauses the loop, retaining unknown acceptance, instead of
automatically retrying. Recovery of a saved `starting`/unknown-acceptance run also pauses it;
a crash between effects and the accepted callback must not repeat the same fire. Reconcile its saved conversation/effects before explicitly resuming.
Foreground intent is likewise saved before dispatch without committing the public fire counter
until `sendUserMessage` returns. An exception, or recovery before that counter commit, pauses
rather than repeating the same occurrence. A returned dispatch with no transcript evidence stays
an explicitly unobserved outcome; the normal schedule can create a *new* occurrence, not retry
that attempt. Hosts must still deduplicate the same id/fire on explicitly reconciled retries.
Definite preparation/child-start failures retain scheduled/bounded retry behavior. A gated
child-start failure gets at most three expedited retries; exhaustion pauses it with its wake
retained, rather than repeatedly retrying every scheduler tick.

## Adoption

The feed starts only when a host loads this version. Older loaded parents and unregistered
origins remain partial coverage. Publishing source or updating a checkout does not reload a
running host. Adopt through the host's normal safe idle/restart process, preserving active turns,
drafts, approvals, paused/expired jobs, context and trust boundaries. No automatic reload or
cross-host installation is performed by this feature. Source delivery, supervisor integration,
host adoption and verified incident follow-through are separate outcomes.
