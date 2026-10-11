# Runtime agent skills

Status: implemented and verified locally and with generic Docker images on the homelab builder. Not deployed to the live service. This supersedes ALL build-time bundling/source-image designs in earlier architecture artifacts.

## Problem and caller usage

Agent configuration is runtime data. A container release must never read local homelab config, fetch configured skill repositories or bake skill content into images. Config changes alone must activate different repositories/refs/assignments after Flux rolls kaeno. Workers must see only assigned skills, including scripts/references/binaries, while durable tasks retain exact old versions.

```json
{
  "skillRepositories": ["poteto/p-stack:v0.2.4", "mattpocock/skills"],
  "templates": {
    "kaeno": { "skills": ["mattpocock/skills:grill-me"] },
    "worker": { "skills": ["poteto/p-stack:poteto-mode"] }
  }
}
```

Other template fields remain required; examples do not assert those repositories/refs are accessible. Runtime startup:

```ts
const skills = await prepareSkills({ repositories: config.skillRepositories,
  selections: Object.fromEntries(Object.values(config.templates).map(t => [t.name, t.skills])),
  cacheRoot: "/var/lib/kaeno/skills" });
// Only now open/refresh/resume Harness and expose channels.
```

Agents keep `skills.bind(template.skills)` in SQLite. The trusted pod initializer reads:

```ts
await materializeSkillSelection("/skill-cache", frozenSelection, "/skills-out");
```

## Core types and identity

`RepositorySpec {id, ref?}` uses canonical lowercase GitHub owner/repo. Refs are Git tags/branches/commit IDs, not shell fragments. Config selectors are versionless `owner/repo:frontmatter-name` or `owner/repo:*`, preserving per-template order. Repository wildcards expand against discovered concrete IDs, sort matches by ID and deduplicate overlaps with explicit selections. Empty wildcard repositories fail. Concrete IDs remain strict: manifests, bindings and init plans never contain `*`. Reject duplicate repositories even with different refs, duplicate selections, undeclared repos and invalid refs/names at config parsing. Omitted fields default empty. Pure config parsing does not import harness or Kubernetes.

`BoundSkill` stores ID, description, disable-model-invocation flag, resolved commit, content/executable-bit tree hash, stable sandbox path and bounded UTF-8 documents. `SkillBinding` is the existing array of those independent JSON snapshots. Binary files remain artifacts, not text tool responses. Metadata never grants tools/credentials/dependencies.

`SkillCatalog.bind(selectors)` expands config selectors through the pure `expandSkillSelection` helper, then enforces the256-skill/8MiB per-agent limits. The catalogue may contain more than256 skills across separate templates; manifest validation is strict on concrete IDs/provenance, not constrained by the config-selector count. This is the model-facing boundary. The current catalogue is ephemeral; durable AgentState snapshots, not the current configuration/cache listing, govern already-created agents. `read_skill` accepts assigned IDs and root-relative text paths only, defaults to SKILL.md, rejects traversal/unassigned/binary requests, and works on nonsandboxed kaeno without shell/file access. Initial prompts contain visible assigned names/descriptions, not entire instructions. disable-model-invocation suppresses automatic advertising, not explicitly requested reads.

New sandbox state freezes `{images:{execution}, skillCacheClaim}` atomically with binding/child creation. `skillSource?` exists only for replay of pre-runtime-cache children; startup parsing and new-child code cannot create a source-image binding. Frozen hash/PVC/image are used when recreating missing pods, never the new catalogue's version. Recreating restores skills, not arbitrary lost task workspace.

## Runtime preparation and cache ownership

`src/skill-repositories.ts` exposes one deep entry point: `prepareSkills(options): Promise<SkillCatalog>`. It hides Git resolution, installer environment, discovery, validation, staging, publication and cleanup. No separate store classes, delivery endpoint or runtime job service.

1. Create cache `trees/`; remove abandoned private `.kaeno-skills-*` work, never published trees. One Recreate kaeno process owns writes; init containers only read.
2. Fresh Git checkout for EVERY declared repo on EVERY startup. Pinned refs fail if absent. Unpinned resolves remote default-branch HEAD; cached packages/artifacts never serve as a Git version lock or silent network-failure fallback. Record resolved commit.
3. Discover selected frontmatter names, or all names for a repository wildcard; expand selectors to concrete IDs before passing explicit names to npx. Preflight original sources before npx: reject symlinks/special files and ambiguous selected frontmatter names. CLI --copy dereferences links and may silently deduplicate, so output-only checks are insufficient. Git metadata is not an asset. Stage only selected trees into a sanitized collection, excluding repository discovery manifests; reject nested SKILL.md/plugin discovery controls inside a selected tree rather than silently leaking other skills or dropping assets.
4. Run pinned `npx --yes skills@1.7.2 add <collection> --skill … --agent pi --copy --yes` in isolated installer cwd/HOME. Git is anonymous: only PATH/empty HOME, disabled terminal prompts, global config `/dev/null` and disabled system config; no auth headers/askpass/credential helpers/provider/channel credentials. npx gets PATH/empty HOME/disabled telemetry/empty user npm config/persistent package-cache path; no Git/provider/channel credentials. Installer lockfiles stay in disposable staging.
5. Match installed metadata, not filenames; validate full tree hash against original selected tree. Preserve scripts/references/binaries/executable bits; omitted/changed assets fail explicitly. Build current catalogue and validate all selections before publication.
6. Publish verified complete trees into `trees/<sha256>` with synced files/directories and atomic same-filesystem rename. Reuse only verified existing hash entries; corruption fails closed rather than overwriting artifacts readers may use. Retain completed trees if a later operation fails. Unique work is removed in finally; next startup cleans crash leftovers.

There is no mutable on-disk catalogue-of-record and no skill lockfile. Provenance is snapshotted with bindings. npm package cache is separate from trees; it caches the pinned CLI, not repository decisions.

Limits: 64MiB/4096 files per tree, 256KiB per text document, 2MiB text per skill, 8MiB text per agent binding and <=256 selected skills per agent. Oversized sources fail; storage exhaustion also fails rather than silently losing old content. Current PVC is 5Gi. No completed-tree GC: safe reference-aware GC is deferred.

## Assigned-only worker filesystem

```text
kaeno pod                             worker pod
  SQLite PVC (private)                  init: frozen execution image
  skill-cache PVC RW                       cache PVC RO (private to init)
    trees/<hash>/…                         selected-output emptyDir RW
    npm/…                                     │ copy+hash validation, no network/credentials
                                              ▼
                                          envd: frozen execution image
                                            writable task workspace
                                            selected-output mount RO at:
                                            /workspace/.agents/skills/<owner>/<repo>/<skill>
                                            NO cache/SQLite mount
```

Init is a Kubernetes prerequisite; no model tools run against half-populated output. It validates frozen IDs/hashes and source metadata/name, clears only its dedicated output volume, stages/verifies every assigned tree, then exposes the completed selection. Repeated init converges. Missing/corrupt old artifacts fail with an actionable initializer message, not current-version substitution. Main has no central skill files in its image or mount; no artifact endpoint exists to expose the store. The worker can independently fetch internet content using its permitted tools; assigned-only availability is about supplied guidance/context, not absolute information secrecy.

Trusted init can privately read all nonsecret cache content. Neither Git/provider/channel credentials nor worker SSH keys are mounted in init. Main retains existing UID10001, readonly root, no ServiceAccount token, dropped capabilities and public-only network policy. No worker→kaeno network opening is added. Cache uses a separate PVC, never SQLite's PVC. local-path/RWO constrains workers to the cache's storage node; this is accepted for the single-node homelab.

## Startup, updates and replay

Flux's configMapGenerator changes the Deployment template when config changes. On every process startup kaeno resolves/validates sources before opening/resuming the Harness or exposing channels. No periodic Git polling/in-process watcher. An explicit Deployment restart refreshes unpinned sources with unchanged config. Resolution failure makes readiness fail/keeps new process offline; it does not admit work against a stale or incomplete catalogue.

Idle root conversations refresh template/binding transactionally at startup/admission, only if no live run, queued inbox items or pending/running/waiting owned tasks. Busy roots keep old bindings; the next idle admission applies current configuration. Children retain their creation binding and image/PVC locator regardless of new assignments or removed current catalogue entries.

Existing source-image children replay their frozen source-image initialization, with no runtime cache mount. Legacy no-skill children adopt their surviving execution image or the generic current runtime. New children always use runtime cache; no compatibility installer/fetch path is added to workers. Keep old source images until old image-backed tasks end, old execution images/cache trees while referenced. No migration deletes PVCs or task state.

## Modules and operations

- `src/config.ts`: pure config parsing/selection validation.
- `src/skills.ts`: domain, metadata, hashing, catalogue, scoped snapshots, selected-tree materialization and new image-ref validation.
- `src/skill-repositories.ts`: runtime preparation/cache publication.
- `src/materialize-skills.ts`: credential/network-free init entry point.
- `src/agents.ts`: durable bindings, scoped tool/prompt, child replay and frozen execution/PVC capture.
- `src/threads.ts`: sole owner of idle-only root refresh.
- `src/k8s.ts`: trusted pod spec, init-only cache mount, readonly assigned mount and init errors.
- `src/kaeno.ts`: startup ordering and cache/image wiring; infer claim from its actual pod volume or explicit override.
- `Dockerfile`, `scripts/deploy.sh`: generic sibling images/release pins only. No config snapshot, source fetching or bundled skill layer. .dockerignore excludes obsolete bundles/config snapshots.
- Homelab `deployment.yaml`, `pvc.yaml`: separate kaeno-skills PVC and main RW mount. No skill-source credential or Secret reference. No active config preferences/network-policy changes.

First activate by building/deploying this application and new PVC/mount configuration together. After that repository/ref/assignment edits are config-only homelab pushes. Only public skill repositories are supported; inaccessible/private sources fail anonymous fetching, with no authentication prompt/fallback. Worker deploy keys are unrelated and unchanged.

## Synthesis and principles

See runtime-skills-plan.md for grounded flow, usage/type contract and rubric. Independent Sonnet5.5 PVC candidate and GPT6.1 Sol HTTP candidate were cross-judged by GPT: PVC23/25, HTTP17/25; parent agrees. High-thinking attempts timed out, lower-thinking retries completed. Choose PVC because it hides delivery inside existing pod construction with no new routes, TLS, grants or per-pod Secret lifecycle. Graft consolidated preparation and existing-binding preservation from HTTP; reject its network relaxation and public storage/transport types. Historical build candidates are superseded.

Redesign from first principles removes the config/image coupling rather than maintaining two install paths. Boundary discipline concentrates source/installer/cache validation at preparation/init and keeps business logic/scoped reads pure. Idempotent operations use immutable hashes, unique staging, atomic publication and repeatable init. Single ownership puts writes in kaeno, binding refresh in threads, and reads in init. We accept startup latency, fail-closed network errors, node-local storage and retained artifacts instead of adding an artifact service/GC before needed. Synced publication does not claim backup or storage-hardware failure guarantees.

## Verification

```sh
npm run check
npm test
sh scripts/verify-runtime-skills.sh # opt-in Docker/Git/npm integration, no push/deploy
```

Verified: actual local Git + actual pinned npx, exact refs and fresh HEAD, new content without rebuilding, dedup across repositories, root-level skills, scoped reads, full assets/modes, failed fetch/ambiguous/linked sources, stale-work cleanup, corruption failure and retained old trees after empty/changed config. Credential probes verify Git ignores inherited auth/config/askpass and both Git/npx exclude Git/provider/channel secrets. A local HTTP401 source fails without sending auth or executing a credential helper. All57 tests pass, including wildcard parsing/expansion, deduplication, scope, post-expansion count/text limits, empty/ambiguous repositories and retained old membership after source changes. Generic-build regression guards forbid config reads/installer/bundle COPY.

Faux-model + real-envd + SQLite restart tests verify root/worker skill use, reference/script execution, surviving and recreated pods, old hashes/image/PVC after current catalogue removal, busy-root preservation and idle refresh. Real Docker smoke builds both images without config/bundles, inspects EVERY layer of both, installs from runtime local Git fixtures as UID10001 with readonly root and actual npx, retries network-free init, then executes only assigned scripts with no cache mount and readonly guidance. Smoke uses temporary images/volumes only, removed afterward. Kubernetes manifests are rendered locally, not applied.

Real public mjrmyr/myriad wildcard preparation also succeeded locally:20 skills at6a552b77abcb1c03b83eea4bb0e20d94391c4281, using anonymous Git and the actual pinned installer; temporary cache removed.

Still unverified: other configured public repositories/refs, actual new PVC scheduling on the live cluster and Telegram/pi with real cloud models after rollout. No deployment/push/staging/commit or user image-pin/config-preference change was performed.
