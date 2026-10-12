# Runtime skills handoff

Authority: architecture/skills.md, architecture/runtime-skills-plan.md, src/skills.ts and src/skill-repositories.ts. Earlier build-time architecture/candidates are historical and superseded.

## User requirement and implementation

Container builds must not depend on local agent configuration or skill repositories. Runtime startup retrieves configured repositories, resolves requested refs/default-branch HEAD fresh, runs npx skills@1.7.2 on sanitized selected local trees, validates full hashes/assets/modes, and publishes immutable trees on a dedicated persistent cache PVC. Git checkouts/lockfiles are temporary. No cached Git-version fallback/lock.

prepareSkills returns current catalogue only after all validation/publication. kaeno.ts calls it before Harness open/resume/channel admission. Startup/config-map rollout refreshes unpinned sources; no periodic polling or live watcher. Nonsandboxed root can read_skill from bounded SQLite binding documents; no arbitrary host file tools. Skills never grant tools/dependencies/credentials. Root/worker lazy prompts advertise assigned metadata only, respecting disable-model-invocation.

Workers receive only assigned trees at /workspace/.agents/skills/owner/repo/name, readonly. New init runs frozen generic execution image, mounts cache PVC readonly privately plus output emptyDir; main mounts output only, never cache/SQLite. Worker network policy still forbids kaeno/LAN/tailnet/Kubernetes; no artifact endpoint. Dedicated cache PVC kaeno-skills (5Gi local-path/RWO) is separate from kaeno-data SQLite. One Recreate kaeno writer; old trees retained, no GC. Node-local scheduling is accepted on single-node homelab.

Child AgentState atomically persists SkillBinding, execution image and skillCacheClaim. Old state may contain images.skillSource: replay ONLY, old source-image init has no cache mount. parseSandboxImages/new creation deliberately omit source-image fields. Legacy no-skill children adopt existing image or current generic execution image. Existing tasks/busy roots retain old bindings; idle root refresh remains owned by threads.ts. Missing old cache artifacts fail rather than substituting current content. Recreated skills do NOT restore lost task workspace.

## Files

- src/skill-repositories.ts: moved/reworked former scripts/build-skills.ts; single prepareSkills API, credential separation, unique staging, synced immutable hash publication, stale-work cleanup.
- src/skills.ts: existing domain/catalogue/scoped reads retained; materializer now reads trees/<hash> cache, verifies metadata/name and hash, stages whole selection.
- src/materialize-skills.ts: init uses /skill-cache -> /skills-out; no network/credentials.
- src/agents.ts/k8s.ts/kaeno.ts: frozen cache locator, init-only PVC mounts, generic images, startup ordering, actionable init failures before generic Pod Failed reason.
- Dockerfile/scripts/deploy.sh: remove ALL config snapshot/build installer/bundle COPY. Still build/push generic worker then kaeno, embedding resolved worker digest and updating homelab pin. No build-time config read. .dockerignore excludes obsolete bundle/snapshot.
- scripts/verify-runtime-skills.sh replaces image-bundled verification script; builds generic images, actual runtime Git/npx in temporary volumes, checks all layers, repeated init and assigned-only readonly worker filesystem.
- homelab apps/kaeno/deployment.yaml,pvc.yaml: new cache PVC/mount; no skill-source credential/Secret. kustomization comment describes runtime updates. User config/model/chat preferences and existing image pin preserved.
- README and architecture/skills.md rewritten for runtime ownership. Older candidate/grounding docs explicitly archived.

## Wildcard assignments

Config permits owner/repo:* for declared repositories. src/skills.ts separates splitSkillSelector from strict splitSkillId, and shares pure expandSkillSelection with runtime preparation. Runtime discovers all names for a wildcard; installer still gets explicit concrete names. bind expands against the prepared catalogue, deduplicates overlaps and enforces256-skill/8MiB limits after expansion. Empty/ambiguous/invalid repositories fail. Manifests/init plans/SQLite bindings stay concrete. Manifest validation no longer incorrectly caps the entire multi-template catalogue at256. Wildcard ordering is lexical ID order within selector order. Tests cover config, boundaries, limits, real Git/npx membership changes and materialization of retained old memberships; the recreated-pod durable case uses wildcard config. Docker smoke uses a wildcard plus overlapping explicit selection.

## Credentials

Public skill repositories only. Removed the token API/startup env/Secret reference. Git gets empty HOME, global config /dev/null, system config disabled, terminal prompts disabled and no inherited auth headers/askpass/credential helpers. npx gets scrubbed env/temp HOME/persistent npm cache; no Git/provider/channel keys. Tests/Docker fixtures rewrite transport using a test-only Git executable, not a production config override. Init gets plan only. Worker deploy SSH key remains separate and unchanged.

## Verification

57 tests pass across seven files; npm run check, shell syntax and diff whitespace checks pass. Tests run actual local Git/actual pinned npx: exact tag/commit, fresh advancing HEAD/new content without image build, collisions/root skills, retained trees after empty/new/failed config, stale work cleanup, corrupt-cache failure, links/ambiguity/missing refs, binaries/executable modes and scoped reads. Subprocess wrappers prove inherited Git auth/config/askpass are ignored and Git/provider/channel secrets absent from both subprocesses. A local HTTP401 fixture verifies an authentication-required repository fails without an Authorization header or inherited credential-helper execution. Generic-build regression guards prohibit config reads/installer/bundle COPY.

SQLite + faux-model + real-envd integration tests preserve bindings after current catalogue entries are removed and recover/recreate child using frozen execution-v1/cache-v1 under current execution-v2/cache-v2. Root read_skill, worker reference/script execution, interrupted shell reporting, busy root preservation and idle refresh verified. Legacy source-image Pod spec also tested.

Real Docker smoke on homelab builder: both generic image layer sets have no SKILL.md/store; runtime Git/npx succeeds as UID10001/readonly root; private readonly cache mounts only in init; repeatable init; worker executes assigned script/reference, has no cache/unassigned tree/write access. Temporary images/volumes/build dirs removed. No registry push or cluster deployment during verification. kubectl kustomize render confirms separate cache PVC/mount, no skill-source credential and user's unchanged b830e544... image pin.

Real anonymous mjrmyr/myriad retrieval with wildcard selection and pinned npx was also verified locally:20 skills at commit6a552b77abcb1c03b83eea4bb0e20d94391c4281. Temporary cache removed. This is source-resolution verification, not live cluster/model verification. User's newly modified homelab config.json was observed and left unchanged.

## Outstanding operations

No staging/commit/push/live deploy. User had modified homelab kustomization image digest before this task; preserved. First activation requires approved new application build/pin plus homelab PVC/deployment edits applied together. Thereafter only config.json pushes needed for sources/refs/assignments. Live public repo availability, new PVC scheduling and real Telegram/pi+cloud-model task remain unverified. Example poteto/p-stack:v0.2.4 had prior authentication failure; do not infer existence or fall back.

Never touch user's tmux server (verification only tmux -L kaeno-verify if needed; none used here), recover deleted docs or push/deploy without approval. Do not stage unrelated user changes. Existing llama.cpp/model volume remains untouched. No workspace persistence/backups/budget controls added.
