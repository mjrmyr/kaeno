# Configured agent skills — architecture

Status: implemented in source and verified with 50 tests plus a real Docker layer/mount smoke test. Not deployed to the live kaeno application yet. Runtime types in `src/skills.ts` supersede the original scaffold. Assigned-only filesystem visibility supersedes the original shared-image design.

## Problem

Kaeno uses pi-durable, not the interactive coding-agent's resource loader. Installed SKILL.md files do not automatically become available skills. We need build-time repository resolution, repository-qualified skill identities, per-template assignment, and lazy instruction loading, without giving the orchestrator arbitrary file tools or changing sandbox isolation. The orchestrator image must contain the skill store, while each worker filesystem must contain only its assigned skills. Copying selected files is insufficient if the complete store remains in the worker image. Resumed children must keep their original skills across orchestrator upgrades.

## Usage (caller’s view)

The existing homelab `apps/kaeno/config.json` remains the only user configuration:

```json
{
  "skillRepositories": ["poteto/p-stack:v0.2.4", "mattpocock/skills"],
  "templates": {
    "kaeno": { "skills": ["mattpocock/skills:grill-me"] },
    "worker": { "skills": ["poteto/p-stack:poteto-mode"] }
  }
}
```

Other existing fields are omitted in this example. No manual installation or separate lockfile.

```sh
# Reads that config, assembles a fresh skill bundle, then builds/pushes/pins as before.
HOMELAB_REPO=../homelab npm run deploy
# Review and push homelab separately; this architecture does not change that workflow.
```

Three integration call sites, implemented against the runtime domain in `src/skills.ts`:

```ts
// scripts/build-skills.ts; deploy.sh passes a snapshot of the homelab config.
const config = await loadConfig(configSnapshot);
await buildSkillBundle(config.skillRepositories, selectionsFrom(config), outputRoot);

// src/kaeno.ts, before opening/resuming the durable Harness.
const skills = await openSkillCatalog("/opt/kaeno/skills", config.skillRepositories, selectionsFrom(config));
const images = { execution: buildInfo.sandboxImage, skillSource: image };
// buildInfo is validated /app/build-info.json; image is this kaeno pod's digest-qualified image.
const agents = createAgents({ config, skills, images, harness: () => harness });

// src/agents.ts, inside the existing child-creation commit (not on replay).
const binding = skills.bind(template.skills);
const state = await tx.doc(AgentState, created.id);
state.skills = binding;
if (template.sandbox) state.sandbox = { pod: podName(created.id), token, images };
// images.execution: bundle-free envd image; images.skillSource: this kaeno image.
// sandboxPod derives an init copy plan from binding IDs/hashes, not the current config.
await configure(tx, created.id, agentChange(template));
// The skills section/tool read state.skills, not current template or current catalogue.
```

`skills` omitted means an empty selection. `skillRepositories` omitted means no repositories. Existing configurations continue to work.

## Shape

### Domain and ownership

- `RepositoryId`: GitHub `owner/repo`, canonicalized to lower case. Scope v1 to GitHub shorthand, not arbitrary URLs.
- `RepositorySpec`: identity plus optional Git ref. `owner/repo:v0.2.4` is Kaeno syntax, not passed verbatim to the skills CLI. Tags, branches (including slashes), or commit IDs may be used. Missing ref means remote default-branch HEAD at this build. Missing/invalid pinned ref fails; no fallback.
- `SkillId`: `owner/repo:frontmatter-name`; no version here. A name follows Agent Skills naming rules. Repository namespaces isolate identical names from different sources.
- `SkillManifest`: schema version, pinned installer version, requested refs, resolved commits, selected entries and deterministic tree hashes. Build provenance only, never an input constraining the next resolution.
- `SkillBinding`: immutable JSON snapshot of selected descriptors and their readable text documents. Stored in the conversation's AgentState at creation/configuration. It holds no credentials and grants no tools.
- `sandbox.images`: two immutable image references frozen at child creation: `execution` (envd, no central skill files in any layer) and `skillSource` (kaeno image containing the exact skill store). A Kubernetes init container uses the source image to populate only the bound skills into a dedicated volume; the worker mounts that volume at `/workspace/.agents/skills`. SQLite holds the model-visible catalogue/documents.

One runtime module, `src/skills.ts`, owns identifiers, manifest validation, catalog binding, rendering, scoped document reads, and verified selected-tree materialization. One build entry point, `scripts/build-skills.ts`, owns git/npx/staging. Keep helpers private; callers do not coordinate clone/install/scan/hash phases themselves. Config calls identifier parsers at its existing boundary. Agents only bind and consume persisted bindings.

This is a deep interface: build callers ask for a bundle; runtime callers open a catalogue and bind selections. They need not know installer output paths, how refs resolve, or where symlinks are rejected. The contract deliberately does not expose subprocess/transport types or a generic installer plugin API.

P-mode principles applied:
- **Foundational thinking:** separate repository identity/ref, qualified skill identity and persisted binding before choosing loader code.
- **Redesign from first principles:** treat skill files as part of a durable agent's environment, including the non-sandboxed orchestrator, rather than bolting discovery onto the current image.
- **Boundary discipline:** validate config, source trees, installer output, manifest and model arguments at their boundaries; keep binding/rendering pure.
- **Laziness protocol:** use two Docker targets sharing one runtime base and Kubernetes init-container ordering; no per-agent image, runtime installer, copying through envd, or extra network service.
- **Make operations idempotent:** isolated build roots, complete-bundle publication and frozen image pair/binding make retries adopt the same artifact; init copying replaces partial output and verifies it before worker start.
- **Prove it works:** exercise the real pinned installer, including its unsafe source-link behaviour, rather than treating documentation as proof.

### Build flow

1. `deploy.sh` snapshots the homelab config once and passes the snapshot to the builder. Never embed the live config (chat IDs, instructions, etc.) in the runtime image; only skill metadata/assets are copied.
2. Use a unique per-build temporary root. For each declared repository, create a fresh checkout and fetch the requested ref or remote HEAD. Record the checked-out commit. Resolve every declaration, even if no template currently selects its skills; skip the installer for empty selections.
3. Preflight the checkout **before installation**: reject symlinks/special files and ambiguous selected frontmatter names. This is necessary because the CLI dereferences source links and can silently deduplicate names. Stage only the selected trees into a sanitized collection; repository-level discovery manifests never enter it. Reject nested skill trees or plugin discovery controls inside a selected tree, rather than allowing unrelated skills or escaping discovery paths. Git checkout metadata is not a skill asset and is never copied. Then union selected names across templates, retaining configured order per template. Install once into an isolated per-repository project:

   ```sh
   npx --yes skills@1.7.2 add /absolute/sanitized-collection \
     --skill selected-name another-name --agent pi --copy --yes
   ```

   Actual subprocesses use argv arrays, not shell interpolation. Local checkout pins the exact content before installation, avoiding a second remote resolution and keeping git auth out of the installer invocation. The installer receives a minimal environment, temporary HOME and empty user npm config, not the agent/provider credentials or the build user's auth files. Git fetching separately uses the builder's normal source authentication. Pinning the CLI is not a sandbox for npm supply-chain code; it remains a trusted build dependency.
4. Scan installed SKILL.md metadata to find requested names, without assuming directory-name equality. Reject missing/ambiguous matches and verify each installed tree's hash against its source: installer-omitted/changed assets fail explicitly. Preserve scripts/references/binaries/executable bits. Limits are 64 MiB/4096 files per tree, 256 KiB/text document, 2 MiB text/skill and 8 MiB text/agent binding, with at most 256 selected skills.
5. Publish a generated bundle containing only the selected skills:

   ```text
   generated skill bundle/
     manifest.json
     mattpocock/skills/grill-me/SKILL.md
     mattpocock/skills/grill-me/references/...
     poteto/p-stack/poteto-mode/SKILL.md
     poteto/p-stack/poteto-mode/scripts/...
   ```

   Hash sorted relative file paths, file contents and relevant mode bits; exclude clocks, temporary paths and installer lockfiles. The CLI's generated `skills-lock.json` remains in staging, never controls later builds.
6. Transfer that exact bundle with a unique per-build context. Split Docker into sibling targets: a shared `runtime-base` containing code/tools but no skills; `sandbox` from that base for envd; and `kaeno` from the base with the store at `/opt/kaeno/skills`. **Do not derive sandbox from kaeno and delete the store:** those files would remain in its image layers. Resolution still happens before Docker, so caching cannot turn an unpinned repo into a stale checkout.
7. Build and push the `sandbox` target, obtain its digest, and embed that computed reference as build metadata in the `kaeno` target (e.g. `/app/build-info.json`). Build/push kaeno, then update its homelab digest pin. Kaeno reads the matching execution digest from this metadata and its own source-image digest from its pod spec. No manually synchronized second image setting is needed. If either build/push fails, do not change the homelab pin. No Git pushes or live deployment are added by this feature.

Repeated pinned builds at the same resolved commits produce equivalent bundles. Unpinned builds intentionally may produce different content; the operation always converges on the inputs resolved for that invocation, not leftovers from earlier attempts.

### Runtime loading

`openSkillCatalog` validates the image manifest and contents before Harness resume. Every configured repository must have the same requested ref represented in the image; every selected skill must exist. Image entries no longer selected are harmless. Do not compare the whole config hash: changing models/chat IDs or moving an already-bundled skill between templates is not a skill artifact mismatch. Adding an unbundled skill or changing a repository ref requires rebuilding and gives an actionable startup error otherwise.

For each agent:

1. A pi-durable extension section reads the persisted binding and advertises IDs, descriptions and sandbox paths. Full documents do not enter the prompt yet. Merely having other files on disk would not itself consume model tokens, but would allow incidental discovery; the assigned-only filesystem requirement prevents that source of unrelated context.
2. A replay-safe `read_skill` tool accepts `{ skill, file? }` (`file` defaults to `SKILL.md`). It reads only that conversation's selected skill documents from the persisted binding. References resolve relative to the skill root; the tool rejects traversal and documents outside the binding. No arbitrary filesystem read is possible.
3. On binding, snapshot valid UTF-8 text documents from the skill tree, with explicit per-file/per-skill limits. Preserve raw documents, including frontmatter. Binary files are bundled in the image but not returned by `read_skill`. Tool responses include the skill's sandbox root so the model can run scripts or read binary assets using its already-assigned sandbox tools. Non-sandboxed kaeno can read guidance but cannot execute its scripts.
4. Before envd starts, an init container copies **only bound skills** from its own source-image filesystem into the skills volume. The worker mounts this at `/workspace/.agents/skills/<owner>/<repo>/<skill>/...`, read-only. It has no central-store image layer, mount, or endpoint. Its `read`/`bash` therefore sees only assigned skill content. Use `.agents`, not a second `.claude` copy; repository-qualified subdirectories retain collision-free IDs. This removes accidental discovery of unrelated guidance. It does not prevent an internet-enabled worker from independently downloading other material.
5. Delegate descriptions include the target template's assigned skill IDs/descriptions to help the orchestrator route work. Content comes from the validated catalogue when describing new agents; resumed child prompts come only from persisted bindings.

The skill extension/tool is selected separately from CodingTools, so kaeno can read its guidance without a sandbox. A skill's `allowed-tools` metadata never changes template permissions. Respect `disable-model-invocation` in automatic catalogue advertising; document its explicit qualified read path without claiming interactive `/skill` commands exist in kaeno.

### Sandbox setup: assigned-only files

```text
kaeno container                         sandbox pod
  full skill store                       init: frozen skillSource image
  durable selected binding                 reads full store in its OWN filesystem
        │                                  copies selected IDs + verifies hashes
        └── bound IDs/hashes ──────────────┤
                                           ▼
                                         dedicated skills emptyDir
                                           ▼ read-only mount
                                         envd: frozen execution image
                                           /workspace/.agents/skills/<assigned only>
                                           no /opt/kaeno/skills store
```

The copy plan is derived from the persisted binding (IDs/tree hashes only), never from current template selection or model-supplied paths. The init container runs the source image with an explicit `materialize-skills` command, not kaeno's default server command. It receives no provider keys, API token, GitHub key or ServiceAccount token. The central store lives only in that init container's private root filesystem; only the selected output volume is shared with envd. No runtime repository fetch is involved.

Kubernetes starts envd only after init succeeds. The initializer validates the source manifest against the frozen plan, clears incomplete generated output on retry, copies the selected trees preserving executable bits, and verifies the complete expected set/hashes before exiting successfully. The output volume is separate from workspace data, so cleanup cannot erase task files. Unassigned directories and temporary copy output must not appear in the worker's mounted tree. Inspect init statuses in `failedReason`, so a bad hash or failed copy yields an actionable error rather than a four-minute readiness timeout.

A dedicated read-only skills volume under the workspace is preferred to directly writing into workspace: scripts/references remain stable through the task, while `/workspace` remains writable. Scripts that need scratch output must use the writable workspace. This is not a new workspace-persistence mechanism.

### Durability and update policy

| Actor/event | Behaviour |
|---|---|
| New child | Atomically store binding and image pair when creating the conversation; init materializes only that binding before envd starts. |
| Resumed child | Reuse its binding unchanged, even if current config has different selections. |
| Surviving sandbox during image upgrade | Keep its initialized skills volume and old execution image; do not recopy from the current store. |
| Missing child sandbox | Recreate using both stored digests; init reconstructs exactly the assigned skills from the old source image. If either image is unavailable, report failure; never substitute current images. Pod recreation still loses task workspace files. |
| User-facing thread | Refresh template and binding only at an idle admission/startup boundary. Busy threads keep their existing configuration; the next admission after they become idle applies the current template. Already queued work can finish with the old selection. |
| Skill tool replay | Reads the stored document snapshot; no git/npx or current-image read. |
| Legacy child | Missing binding means no skills. An existing pre-feature pod may finish without changes. If its pod is missing, recreate using the current bundle-free execution image with no skill copy. Persist the new image pair when adopted; never retroactively add skills to old children. |

`threads.ts` remains the sole owner of thread creation/refresh. Consolidate its existing new-thread and refresh configuration path into one transaction-scoped helper; do not add timers, a second migration document, or a registry reload service. Detect idle from durable work, not HTTP connections. Root skill documents are persisted so even a non-sandboxed thread paused across an upgrade can read its old references.

Retain **both** image digests while live child conversations depend on them. If image garbage collection is introduced, it must consult those references. Older envd images must remain protocol-compatible with the new RemoteExecutionEnv; this feature does not promise arbitrary cross-version compatibility.

### File map

| File | Responsibility |
|---|---|
| `src/skills.ts` (new) | Domain parsing, catalog/manifest boundary, binding, scoped reads and prompt rendering. |
| `scripts/build-skills.ts` (new) | Fresh git resolution, pinned npx invocation, installed file verification, deterministic bundle. |
| `src/config.ts`, `src/cron.ts` | Pure build-compatible config/cron parsing; validate repositories/selections without importing harness or Kubernetes machinery. |
| `src/agents.ts` | Skill section/tool, atomic child binding and image pair, delegation descriptions. |
| `src/k8s.ts` | Derive init copy plan from frozen binding; selected-only skills volume; init-aware startup errors. |
| `src/materialize-skills.ts` (new) | Init entry point: validate plan/source, retry-safe selected-only copying and verification. |
| `src/threads.ts` | Bind new threads; refresh existing threads only when idle. |
| `src/kaeno.ts` | Validate catalogue/build metadata before resume; obtain execution/source image pair and register skills. |
| `scripts/deploy.sh`, `Dockerfile`, `.dockerignore` | Snapshot, isolated context, sibling image targets, computed execution-image metadata and kaeno pin; exclude source checkouts. |
| `test/skills*.test.ts` (new) | Parser/build fixtures, scoped reads, config compatibility, real-envd durable integration. |

## Synthesis decision

Two independent candidates were produced: A (host assembler) and B (Docker resolver). A is the base: it fits today's SSH build flow without BuildKit auth plumbing, a mandatory cache-busting build argument, or a new runtime service. The independent cross-judge preferred A, 18/25 vs B's 16/25. My red-flag screen agrees on the base, but rejects parts of both.

Original grafts from B: persist image identity, descriptions/entrypoints, and avoid replacing busy-thread selections. Rejected from A: copying through envd into a mutable workspace while leaving the full store in the same worker image, strict full-config equality, and rendering old bindings from current metadata. Rejected from B: unrelated root-sandbox provisioning and disallowing non-sandboxed skill assignments. Persisted bounded text supports kaeno's lazy reads across upgrades.

**Revision after user feedback:** assigned-only filesystem visibility is now foundational, not merely a prompt policy. The old single-image assumption is removed. Compare (a) init-container copying from a frozen source image into a selected-only volume and (b) kaeno pushing assets through envd. Choose (a): it makes setup a Kubernetes prerequisite, avoids exposing a half-populated tree to model tools, preserves binary assets/modes, and needs no new remote-upload protocol. A sibling bundle-free execution target is required either way. The previous conclusion that copying was unnecessary is superseded.

The judge's claim that an emptyDir is lost on a container restart was incorrect: emptyDir survives container restarts, but not pod deletion. The revised design reconstructs skills when the pod is recreated using the frozen source digest; it does not reconstruct arbitrary task workspace files.

Initial high-thinking runs timed out without output; reruns produced complete candidates on Sonnet 5.5 and GPT-6.1 Sol. No candidate modified the repository. Candidate outputs and judge are preserved in `skills-candidates/` for traceability, not as implementation authority.

## Tradeoffs accepted

- We accept rebuilds for new skill sources/content in exchange for no runtime network/install service.
- We accept that unpinned refs and movable tags can change in exchange for the requested user experience. Use a commit ID for stronger immutability; provenance records what actually shipped.
- We accept bounded document duplication in SQLite in exchange for stable lazy reads by both sandboxed and non-sandboxed agents after upgrades.
- We accept retaining both old image digests in exchange for deterministic sandbox recreation and skill reconstruction.
- We accept a second Docker target and one init step in exchange for a worker filesystem containing only assigned skills. Shared base layers avoid duplicating the toolchain unnecessarily.
- We accept read-only assigned skill directories in exchange for stable guidance; skills must write scratch/output files elsewhere in the writable workspace.
- We accept source authentication on the build machine in exchange for not distributing repository credentials into build/install outputs or borrowing the sandbox secret.

## Alternatives considered

- Docker multi-stage resolver: can work with a config snapshot, freshness argument and BuildKit secret transport, but callers must coordinate those three mechanisms; it hides less than the host assembler in this existing deployment.
- Runtime installer/PVC catalogue: avoids rebuilding but introduces mutable content, installation races, network errors and credential ownership into agent lifecycle. Not justified.
- Persist only skill IDs/digests: smaller state but leaves root document reads dependent on current-image files, breaking paused conversations after upgrades.
- Per-template images: enforce the same visibility but multiply builds and bind assignment changes to image production. Two shared targets plus selected-only init copying are sufficient.
- Copy selected skills but keep one full-store image: leaves the store discoverable through bash and does not meet the revised requirement.
- Push through envd: can meet visibility with a bundle-free worker image, but requires handling partial uploads and readiness in application code instead of native init ordering.

## Open questions and risks

- Is `poteto/p-stack:v0.2.4` available under the builder's GitHub identity? The HTTPS probe failed authentication; it does not establish whether the example repository/tag exists. No automatic fallback will mask this.
- Are later private sources accessible through the build host's normal Git authentication? No new credential mechanism is included initially.
- What document/bundle size ceilings accommodate the actual chosen repositories? Measure them before selecting constants; failures must name the offending skill/file.
- Will future registry pruning preserve active execution **and source** image references and RemoteExecutionEnv compatibility? There is no new registry GC in this feature.
- Do the chosen skill scripts assume they can write next to their own source? The selected directory is read-only; inspect actual bundles and document writable-workspace usage.

These are implementation boundary checks, not blockers to the architecture. Do not expose tokens/keys in diagnostic logs.

## Next operational step

Choose actual repositories/selections in homelab config, run the approved deployment build, review the image pin and push/reconcile homelab. Live model/cluster skill verification remains separate from the completed local and Docker checks. No user configuration, Git push or live deployment was changed during implementation.

## Verification / implementation sequence

The installer evidence is reproducible with `sh architecture/verify-skills-installer.sh`. It downloads only the pinned CLI, uses temporary local fixtures with a scrubbed environment, and cleans them afterward. Runtime code and all fixture tests are checked with:

```sh
npm run check
npm test
# Opt-in Docker check with a fixture context (see script header):
sh scripts/verify-skill-images.sh <prepared-fixture-context>
```

Verified: exact tag/commit and fresh default-branch resolution with real local Git; the actual pinned npx CLI; cross-repository name collisions, root-level skills, missing/duplicate/linked sources; lazy scoped reads; selected-only copies; faux-model/real-envd script execution; paused/recreated children retaining old images/bindings during upgrade; busy-root preservation and idle refresh. The real Docker smoke ran on the homelab builder, with temporary local tags/volume only—no registry pushes or cluster deployment. It inspected every sandbox image layer and ran UID10001 with a read-only selected-only mount. Production dependency audit reported zero vulnerabilities.

1. Parser tests: empty/backward compatible config, canonical repo identity, optional ref, branch refs with slashes, commit IDs, duplicate refs for same repo, undeclared sources, malformed qualified IDs, duplicate assignments and order preservation.
2. Builder fixtures: two local Git sources with same skill name, differing directory/frontmatter names, selected-only union, exact tag/commit, nonexistent ref, advancing default branch on consecutive builds, bad metadata, missing skill, escaping links, binary assets, executable mode preservation, and incomplete build cleanup.
3. Real pinned CLI spike: `npx skills@1.7.2 add` on a local skill checkout with `--agent pi --copy --yes`. Verified during architecture: entrypoint and reference copied byte-for-byte, bundled script prints `skill-probe-ok`; the CLI emits a staging lockfile. A separate harmless link fixture proved that an outside source file is dereferenced into the output, so source preflight is mandatory. No remote repository content or cloud model was needed.
4. Catalogue boundary tests: supported config-only reassignment works; unknown skill and changed ref fail before resume. Bound catalogue/text remains stable if the current image catalogue is replaced. Deny unassigned skill, traversal and binary document reads.
5. Faux model + real envd: read selected SKILL.md, read reference, run bundled script using sandbox path, report exact marker. An orchestrator-only skill loads without file/shell tools. Delegate descriptions expose intended specializations.
6. Crash/reopen tests: same frozen image pair/binding; upgrade catalogue with changed/removed skill; missing sandbox recreates old execution image and rematerializes selected skills from old source image; missing either image fails explicitly. Retry init after an interrupted copy and verify only the complete assigned set becomes visible. Legacy no-skill children still work. Busy root keeps old binding until idle admission. No implicit command replay or newly granted tools.
7. Full typecheck and existing 32-test suite, plus Docker/pod smoke tests: kaeno holds the full store; sandbox target has no store in any layer; init produces exactly the assigned files with references/executable bits; worker sees `/workspace/.agents/skills` read-only and `/opt/kaeno/skills` absent. A bash listing/recursive search must find no unassigned bundled skills. Verify an empty selection, failed init readiness/error handling, and that no credential/checkouts appear in either image or the init environment. Live cluster verification is a separate approved deployment step.
