# Runtime skills implementation plan

## Workflow
- [x] Ground: trace current repository resolution, startup, durable bindings, sandbox init, images and deployment.
- [x] Sketch: compare persistent-cache init copying versus authenticated artifact delivery.
- [x] Agree: user approved runtime resolution, generic images, persistent cache, assigned-only workers and durable versions.
- [x] Implement: replace build coupling, integrate startup/PVC materialization, update tests and operational config.
- [x] Scrap: remove obsolete build-only CLI/docs/verification assumptions; verify target architecture.

## Grounding
Overview: the old lifecycle begins in scripts/deploy.sh, snapshots homelab config, invokes scripts/build-skills.ts, and COPYs the resulting union into the kaeno image. src/kaeno.ts opens that image catalogue before Harness.resume. The user now requires configuration to be runtime data rather than a build input.

Key concepts: RepositorySpec requests a Git ref or default-branch HEAD. SkillManifest records resolved commits/tree hashes; SkillCatalog creates independent bounded BoundSkill documents. AgentState persists bindings and sandbox image pair. read_skill and prompt sections read the persisted binding, not the current catalogue. threads.ts refreshes only idle conversations. These domain/durability policies remain valid; image-based source delivery does not.

Flow: config -> builder Git/npx/preflight/hash -> image catalogue -> agents -> atomic child binding/image capture -> k8s init from source image -> selected-only emptyDir -> readonly worker mount. New startup must own the first two steps, publish immutable trees to persistent storage, and keep old trees reachable independently of current selections. Source image must disappear for newly created children.

Where: src/skills.ts owns parsing/metadata/hash/scoped documents/copy; scripts/build-skills.ts owns safe resolution/installation; src/kaeno.ts owns startup ordering; src/agents.ts owns child/replay lifecycle; src/k8s.ts owns trusted pod shape; Dockerfile/deploy.sh own releases. Homelab deployment uses Recreate/single writer, nonroot UID/fsGroup10001, readonly root, /data SQLite PVC and /tmp256Mi; networking already permits kaeno public HTTPS for Git/npm. Worker network cannot reach kaeno, and must remain so.

Gotchas: adding endpoints requires opening worker->kaeno network access (init and main share Pod IP); sharing the SQLite PVC would expose unrelated durable data to init and is forbidden. A dedicated cache PVC mounted ONLY by init can preserve existing network policy and main-container filesystem isolation. local-path/RWO scheduling is node-bound, accepted on the single-node homelab. Existing durable children may carry old source-image pins; retain legacy replay without creating new source-image bindings. No GC of immutable trees while durable tasks might reference them. Startup failure must precede Harness resume/turn admission. ConfigMap-generator changes already restart Deployment; no hot watcher required. Installer env must exclude provider/bot/API/Git credentials. Only public skill sources are allowed; Git must fetch anonymously and ignore inherited credential helpers/config/auth headers.

## Comparison rubric
Score each candidate 1–5: runtime config/image independence; assigned-only filesystem/network isolation; durable replay and crash consistency; ownership/interface depth; fit to current single-node operational model. Prefer fewer services/protocols when tied.

## Usage and shape (implementation contract)

```ts
// kaeno startup, before opening/resuming the harness:
const skills = await prepareSkills({ repositories: config.skillRepositories,
  selections: Object.fromEntries(Object.values(config.templates).map(t => [t.name, t.skills])),
  cacheRoot: "/var/lib/kaeno/skills" });
// Child creation retains existing bounded SkillBinding; freezes execution image + cache PVC claim atomically.
const binding = skills.bind(template.skills);
// Trusted init, with ONLY dedicated cache PVC readonly and selected-output emptyDir:
await materializeSkillSelection("/skill-cache", frozenSelection, "/skills-out");
```

`src/skill-repositories.ts`: `prepareSkills(options): Promise<SkillCatalog>` owns Git/npx/source validation, unique staging, verified immutable publication into `trees/<hash>`, and cleanup. Fresh resolution on EVERY startup; no fallback to old HEAD. npm package cache is retained separately, never used to lock Git revisions. Git disables global/system config, inherited auth and prompts; Git/npx get no Git/provider/channel credentials.

`src/skills.ts`: keep BoundSkill/SkillBinding/domain parsing/scoped reads. Materialization now reads tree hashes in runtime cache; validates metadata/name/content then stages all assigned trees. SandboxImages now freezes execution only for new children; optional skillSource is replay-only legacy compatibility. Cache PVC claim is also persisted per child, so recreation uses its original storage and image.

`src/k8s.ts`: new init runs execution image, mounts dedicated cache PVC readonly and output emptyDir. Main mounts only output readonly, never cache. Legacy frozen source-image children retain their old init path. `src/kaeno.ts` resolves skills before Harness admission/resume. `Dockerfile`/deploy no skill files, fetch, local config snapshot or installer step. Homelab adds dedicated 5Gi skill-cache PVC, RW in kaeno, no skill-source Git token/Secret; no network-policy widening.

## Synthesis decision
Public-only revision: the user removed private-source support. Delete token API/startup/Secret plumbing; anonymous Git is enforced with empty HOME, global config /dev/null, system config disabled and no inherited auth environment. Tests use local transport wrappers, not a production config escape hatch. Candidate credential proposals below are historical.

Independent PVC and HTTP candidates produced by Sonnet5.5 and GPT6.1 Sol; high-thinking runs timed out, lower-thinking retries completed. GPT cross-judge scored PVC23/25 vs HTTP17/25; parent agrees. Choose PVC: no new network route/auth/TLS/Secret-per-pod lifecycle and natural fit to single-node local-path/RWO. Graft consolidated preparation entry point and existing binding preservation from HTTP. Reject public storage paths, new binding union replacing existing documents, and redundant store classes/has/publish interfaces. Runtime cache uses one writer, immutable trees; no GC. All source/layout complexity stays behind prepareSkills/materializeSkillSelection.

Accepted tradeoffs: init can see all nonsecret skill trees privately; worker cannot. Single-node PVC locality remains; node-scale artifact delivery is deferred. Failed network/source resolution prevents new startup admission rather than silently using cached mutable refs. Legacy replay-only image support preserves existing tasks. Atomic, synced publication is distinct from backups or guaranteed storage-hardware durability.

## Principles
Redesign from first principles: eliminate config inputs from builds, do not add a second fetching path.
Boundary discipline: Git/npx/cache validation at runtime preparation and init boundaries; internal bindings remain trusted.
Make operations idempotent: immutable hash-addressed publication, unique staging, retries clean abandoned work, retain completed artifacts.
