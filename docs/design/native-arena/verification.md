# Verification of the native design scaffold

> These five probes validate same-Harness delegation primitives; they predate the running implementation. The current [contact + native background Job + custom TUI](../minimal-kaeno.md) is separately tested by `npm test` and a PTY smoke check. Live provider and crash-window verification remain open.

## Executed

Node v24.21.0; published `@earendil-works/pi-durable`, `pi-ai`, `chord` 1.1.0; TypeScript 5.9.3; @types/node 24.19.1. Dependencies installed under `/tmp/kaeno-native-verify`, not in the repository.

- Strict scaffold typecheck (`skipLibCheck` excludes dependency internals only): passed.
- Emitted public declaration contains no Durable/Chord types: passed.
- Five native primitive probes: **5 passed, 0 failed**.
  1. Background ownership permits another contact answer; ordinary contact abort leaves the job alive.
  2. Safe creation-only tool reruns after graceful close/reopen before tool-result commit; commit-local identity lookup retains one job and child.
  3. A background owner with a decided outcome stays `completing` while ordinary owned work drains. This disproves the candidate's early-capacity-release assumption.
  4. Table read after task creation throws `ReadAfterWrite`; the rejected commit creates no task.
  5. A queued notice withdrawn by contact abort remains aborted when retried with the same ID, including changed content.

Final probe output:

```text
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

## Reproduce in an isolated directory

Run from the repository root. These commands do not install a production Kaeno package:

```sh
VERIFY=$(mktemp -d)
npm install --prefix "$VERIFY" --ignore-scripts --no-audit --no-fund \
  @earendil-works/pi-durable@1.1.0 @earendil-works/pi-ai@1.1.0 \
  @earendil-works/chord@1.1.0 typescript@5.9.3 @types/node@24.19.1
cp docs/design/kaeno.sketch.ts "$VERIFY/kaeno.sketch.ts"
cp docs/design/native-arena/probes.mjs "$VERIFY/probes.mjs"
"$VERIFY/node_modules/.bin/tsc" --noEmit --strict --target ES2022 \
  --module NodeNext --moduleResolution NodeNext --skipLibCheck "$VERIFY/kaeno.sketch.ts"
"$VERIFY/node_modules/.bin/tsc" --declaration --emitDeclarationOnly --strict \
  --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck \
  --outDir "$VERIFY/declarations" "$VERIFY/kaeno.sketch.ts"
# Must print nothing: public declarations must not expose framework types.
grep -E '@earendil|TaskId|Context|ConversationId' "$VERIFY/declarations/kaeno.sketch.d.ts"
node --test "$VERIFY/probes.mjs"
```

Native probes use the faux provider only. No real model call, credentials, external mutation, or repository file write is needed by them; their SQLite database is a disposable temp fixture. The verification environment's dependency-lock hash was `2763fd53e8af4a6c1e5a68a76966fbc70638a92d33267ab9dbab5cd47318ad9b`; this records the executed environment, not a claim that future transitive npm resolution yields that hash. Pin the full production dependency lock when implementation starts.

## What this does not prove

The historical sketch deliberately throws `not implemented`; it is not the running Kaeno implementation. These probes exercise native mechanics only, and close/reopen is not an exhaustive process-kill/power-loss experiment. At the time of this arena, job result-finalization, quota policy, owner gate and startup-drift checks had not been implemented; see [`src/jobs.ts`](../../../src/jobs.ts) and [`minimal-kaeno.md`](../minimal-kaeno.md) for the current state.

The source review used commit `6fb2e7815167e6b19006fc526d1a5d0f5f998787`; executed tests used published version 1.1.0. We do not assert that the release tarball was built from that exact commit.

## Required implementation tests

- Transactional global/per-agent/retention rejection, including decided-but-completing jobs.
- Replayed delegate after catalog edit/removal; conflicting normalized request under one origin.
- Child submission/answer/card/report commit crash windows and exceptional terminal missing-card repair.
- Terminal Job with pending notice, queued notice withdrawn, and failed-contact stranded inputs.
- Targeted cancellation during work/report, preserved success card, aborted or uncertain report admission.
- Table-read-before-write ordering in every mutation path, not just admission.
- Contact/runtime snapshot validation before implicit scheduling by submit/wait.
- Actual single-owner lock, abrupt owner death, and no release before close joins invocations.
- Serialized/coalesced snapshot delivery, watch overflow, reconnect, stale incarnation callbacks and listener errors.

Scrap signal: if those tests repeatedly require anchors, shared transcript leases, a second scheduler or a second task authority, re-run architecture rather than hide them behind the facade.
