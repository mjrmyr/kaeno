# Skill implementation handoff

## Current task
User approved revised architecture and asked to compact then implement. No harness compaction tool available; this file preserves context. Implement locally, verify; do not deploy/push/stage/commit without permission.

## Agreed design (authority: architecture/skills.md and src/skills.ts; original type scaffold superseded)
- Homelab apps/kaeno/config.json is user source of truth. Top-level skillRepositories: ["poteto/p-stack:v0.2.4", "mattpocock/skills"]. Per-template skills: ["poteto/p-stack:poteto-mode"]. Optional ref means current default-branch HEAD on EACH build, not release. Pinned ref/tag/branch/commit fails if absent. Qualified selection omits ref. Reject duplicate repositories, malformed/undeclared/duplicate selections. Empty/omitted fields remain compatible. No lockfile constrains next build; commit hashes are provenance.
- Use pinned npx skills@1.7.2 add <absolute detached local checkout> --skill <names...> --agent pi --copy --yes. Separate staging cwd per repository; scrub installer env/HOME/npm config. Git fetching can use build user's normal authentication, not sandbox secret. Resolve on host before Docker caches.
- Installer spike verified entrypoint/reference bytes and executable script; CLI emits skills-lock.json in staging. IMPORTANT CLI dereferences source symlinks! Source preflight BEFORE invocation rejects links/special files/escaping plugin paths/ambiguous selected names, then validate installed output. Script: architecture/verify-skills-installer.sh.
- Assigned-only worker filesystem is REQUIRED for avoiding incidental context, not merely prompt advertising. NEVER put full store in worker image/layers. Sibling Docker targets from skill-free runtime-base: sandbox envd/tools only; kaeno has store /opt/kaeno/skills. Do NOT derive sandbox from full kaeno then delete store.
- Init container uses frozen kaeno/source image, copies only bound IDs/tree hashes to dedicated skills emptyDir. Worker mounts read-only /workspace/.agents/skills/<owner>/<repo>/<skill>. No .claude duplicate. Preserve scripts/references/binary assets/modes. Init verifies complete exact set; retries clear only generated output, not workspace. No keys/tokens/SA in init. Main starts only after success; report init failures explicitly.
- Build/push sandbox target, bake computed sandbox digest into kaeno build-info.json, build/push kaeno, pin only kaeno digest in homelab after success. Single generated reference avoids manual sync. Unique per-build remote dirs; no shared kaeno-build races.
- Binding persisted atomically with conversation: qualified IDs, descriptions, flags, source commit/tree hash, sandbox paths, bounded UTF-8 document snapshots. Scripts/binaries are in source image, all assigned text reads lazy. read_skill tool scoped to assigned snapshot; kaeno has no arbitrary fs/env. Skill metadata never grants tools/credentials. Advertise assigned names/descriptions only; hide disable-model-invocation from auto catalogue, explicit read works. Delegate descriptions include target skills.
- Sandbox state freezes image pair {execution, skillSource}. Surviving child retains binding/files. Missing pod recreates both frozen images and selected assets, not arbitrary workspace. Fail visibly if images unavailable; don't substitute. Retain both digests for live children. Legacy child has no skills; may finish old pod; missing pod uses bundle-free current image and empty selection.
- Root thread updates selection/template only at idle startup/admission boundaries; busy/queued work may complete old config. Keep threads.ts sole configuration owner. No extra reload service/timer. Documents stay durable for non-sandboxed kaeno through upgrade.

## Initial repository / verification (before implementation)
Kaeno cwd /Users/km/projects/kaeno. Clean tracked tree; architecture artifacts untracked (candidate outputs archived; not implementation instructions). Production unchanged. Dependencies pi-durable/pi-ai/chord pinned 1.1.0; TS5.9 erasableSyntaxOnly; Node>=24 strip types; Vitest3.2.7. 32 existing tests passing. Main files src/config.ts, agents.ts, threads.ts, kaeno.ts, k8s.ts, Dockerfile, scripts/deploy.sh. Read architecture before implementation.
- createAgents currently configures child once in commit, stores template/pod/token, uses CURRENT orchestrator image for all create/recreate. Must replace for new children with pair.
- config validates coding tools require sandbox. Current root no coding tools. Worker uses gpt-6.1-sol in user's homelab config; don't overwrite preferences/chat ID.
- refreshThreads currently configures ALL threads on startup including busy ones. thread currently returns found without refresh. Need one shared transaction helper with live task inspection.
- Pod emptyDirs survive container restarts, not pod deletion. Existing resource limits/read-only root/nonroot uid10001/SA-no-token/network isolation must remain.
- No actual poteto/p-stack:v0.2.4 fetch verified (HTTPS auth failure could mean missing/private). Do not infer existence or fallback.

## Existing deployment / sensitive boundaries
Homelab /Users/km/projects/homelab. Cluster working. Original commits d42d6fe/d8d3c20 were pushed by user; check current status rather than assume. User's Telegram/GitHub now working. SOPS manifests apps/kaeno/kaeno.secret.enc.yaml (API token+Anthropic/OpenAI+Telegram), github-ssh.secret.enc.yaml (dedicated sandbox key). Do not print secrets or copy them to builds/init. Never touch user's tmux server; isolated testing only tmux -L kaeno-verify if needed. Don't inspect deleted docs or git history. No automatic deletion llama stack, no backups/budgets requested. ROADMAP deferred files, long-lived agents/mobile.

## Planned implementation order / tests
1. Domain/config parsing and local-fixture builder (exact refs/latest/collisions/metadata paths/modes/symlinks).
2. Catalogue, persisted binding, read_skill and selected-only materializer; empty/unknown/ref drift/traversal/binary/limits.
3. Agents/threads/Kubernetes image pair + init spec, legacy/replay/idle update tests using faux model + real envd.
4. Deploy/build sibling targets and generated runtime metadata; Docker smoke if available, no cluster change.
5. All tests/typecheck. State clearly which live behaviours remain unverified. Encode restrictions in structure, keep module APIs small.

## Implementation result
Completed src/skills.ts, src/materialize-skills.ts, scripts/build-skills.ts, sibling Docker targets and deploy wiring; config/agents/threads/k8s/main integrate bindings and image pairs. Extracted pure cron into src/cron.ts so build config does not import harness/k8s. YAML dependency pinned2.9.1. Original stub contract removed; runtime types are authority.

50 tests pass, including actual local Git/npx builder fixtures (fresh HEAD/pins, same-name repos, root skills, failed source/rebuilds), scoped reads/copy/metadata, and faux-model+real-envd durable upgrade tests with both surviving and recreated pods. Busy roots preserve bindings; idle admission updates them. A Docker smoke on homelab inspected all sandbox layers and ran UID10001 with selected-only read-only skills; no central store, unassigned skill or write access was present. Verification used temporary local tags/volume only, removed afterward: no registry pushes/cluster changes. Zero production dependency audit findings. No live config change/commit/staging/push.

Pending: user chooses real sources/selections, approved deploy build and homelab push/reconcile, live Telegram/pi+cloud-model skill test. Current source configured examples were not fetched from private repositories. If compacted now, inspect git status and README/architecture/skills.md before continuing.
