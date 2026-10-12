# Candidate A: host-side skill bundle assembled before Docker build

## Problem

Skills must reach sandboxed agents without giving Kaeno file or shell tools, and without startup-time network fetches. Config lives only in `homelab/apps/kaeno/config.json`, so the bundle must be built from that exact file. Sandbox pods use the _current_ orchestrator image on recreation, so a bundle baked into the image can drift under a surviving child. Assignment and content therefore have to be frozen per child.

## Usage (caller's view)

```
# scripts/deploy.sh, before tar
node scripts/build-skills.ts ../homelab/apps/kaeno/config.json .skill-bundle
# .skill-bundle/ is NOT in .dockerignore; Dockerfile: COPY .skill-bundle /opt/kaeno/skills
```

```ts
// src/kaeno.ts (startup, before refreshThreads/resume)
const skills = await loadSkillBundle("/opt/kaeno/skills", config); // throws on drift
// src/agents.ts agentChange
const frozen = skills.freeze(templateName);           // FrozenSkills (ids + digests)
await delegate({ ..., instructions: skills.promptFor(frozen) });
```

```ts
// src/threads.ts refresh
const next = skills.freeze(templateName); // thread policy: re-freeze on refresh
```

## Shape

### Module map

- `src/skills/build.ts` (host only, run by deploy script): **single owner** of git, `npx`, name scanning, and manifest. Public surface: one function.
- `src/skills/bundle.ts` (runtime, pure): reads manifest, validates against config, exposes `SkillBundle`.
- `src/config.ts`: parses `skillRepositories` and template `skills`; no fetch logic.
- `src/k8s.ts`, `agents.ts`: consume `FrozenSkills` only.

### Types

```ts
// config.ts
type RepoSpec = { repo: string; ref?: string }; // "poteto/p-stack:v0.2.4"
type SkillRef = { repo: string; name: string }; // selection omits version
// parseConfig invariants: no duplicate repo (any ref); every SkillRef.repo is in
// skillRepositories; names non-empty. Config gains skillRepositories: RepoSpec[]
// and Template.skills: SkillRef[].

// skills/build.ts
export function buildSkillBundle(
  configPath: string,
  outDir: string,
  opts?: { git?: GitPort; installer?: InstallerPort },
): Promise<Manifest>;

interface GitPort {
  checkout(
    repo: string,
    ref?: string,
    dest: string,
  ): Promise<{ commit: string }>;
}
// pinned: fetch exact ref, throw if absent. unpinned: default-branch HEAD, always re-resolved.
interface InstallerPort {
  install(checkout: string, names: string[], dest: string): Promise<void>;
}
// real impl: npx skills@1.7.2 add <abs checkout> --skill <names...> --agent pi --copy --yes
// run with cwd=<per-repo temp dir>, argv array (no shell), minimal env (no cloud/GitHub creds)

// skills/manifest (bundle.ts)
type Manifest = {
  version: 1;
  configDigest: string; // sha256 of canonicalized skill-relevant config
  installerVersion: "1.7.2";
  repos: Record<
    string,
    {
      requested?: string;
      commit: string;
      skills: Record<string, { dir: string; treeDigest: string }>;
    }
  >; // keyed by metadata name
};

// skills/bundle.ts
export type FrozenSkills = {
  readonly entries: {
    repo: string;
    name: string;
    path: string;
    treeDigest: string;
  }[];
}; // persisted in AgentState
export interface SkillBundle {
  freeze(template: string): FrozenSkills;
  promptFor(f: FrozenSkills): string; // names, descriptions, in-sandbox paths
  stage(f: FrozenSkills, env: RemoteExecutionEnv): Promise<void>; // see lifecycle
}
export function loadSkillBundle(
  dir: string,
  config: Config,
): Promise<SkillBundle>;
```

### Build algorithm (inside `buildSkillBundle`)

1. Parse config via `parseConfig`; collect selected names per repo (union across templates).
2. Per repo, fresh temp dir: clone, resolve ref (exact pin or HEAD), record commit.
3. Run installer into an isolated per-repo install root. Scan installed `SKILL.md` frontmatter `name` to map requested name to directory. Missing requested name: fail. Never trust the directory name.
4. Reject symlinks escaping the skill root and paths with `..`. Compute a tree digest per skill. Move into `outDir/<repoSlug>/<dir>`, write `manifest.json`.
5. Delete `outDir` first on every run. Deploy always runs this before `docker build`, so unpinned refs re-resolve before any layer caching. The bundle directory contents change, so the COPY layer invalidates correctly.

Collisions are impossible across repos because the path is namespaced by repo, and the qualified name is `repo:name`.

### Runtime

`loadSkillBundle` recomputes `configDigest` from the mounted ConfigMap config and compares to the manifest. A mismatch at startup is a hard failure before `resume`, which catches the config-only change case (ConfigMap edited without rebuild). It also verifies treeDigests against disk. There is no network access at runtime and no lockfile; commits are recorded provenance only.

## Lifecycle: image upgrades and old children

The risk is that a missing pod recreated after an upgrade has the new image's bundle while the child was assigned old skills.

- `freeze()` is called once in `delegate` and stored in `AgentState` (entries with treeDigest). Prompt is derived from the frozen entries, never from current template.
- Pod mount: bundle stays in the image at `/opt/kaeno/skills`, but the child reads skills from the **sandbox workspace** copy, not the image path. On first configure, `stage()` copies the frozen skills into the sandbox via envd (`/workspace/.agents/skills/<repo>/<name>`) through RemoteExecutionEnv. Kaeno needs no file tools; the harness does the copy, with the same boundary as other env operations.
- Replay: `stage()` is idempotent and checks digest. For an existing pod, files persist (workspace emptyDir) and are not touched. For a recreated pod on a new image, `stage()` compares the frozen treeDigest with the new image's bundle. If it matches, copy. If it does not (skill changed or dropped), **fail the child loudly** with a "frozen skill unavailable" error rather than silently substituting. Retaining older bundles in the image is out of scope; documented tradeoff.
- Threads: `refreshThreads` re-freezes from the current root template at startup (existing refresh policy), but only for threads with no in-flight task. Active ones keep their frozen entries until idle. Migration: a missing `frozen` field in old AgentState means no skills.
- Rebuild during an active child: the child's frozen entries, not the new manifest, drive prompt and staging.

## Security

Argv arrays only; repo and ref strings validated against `^[\w.-]+/[\w.-]+$` and a ref charset before use. Installer runs with a scrubbed env. Build-time git auth is the host's own and separate from the sandbox SSH key. Skills grant no tool or credential permissions; they are prompt plus files. Third-party content is trusted only as much as any prompt text is, and commit hashes in the manifest give an audit trail.

## Tests

1. **End-to-end (fake model, real envd):** assigned skill's SKILL.md is read and its bundled script runs; no cloud cost.
2. Config: duplicate repo with different refs is rejected; selection with unlisted repo is rejected.
3. Build with fake GitPort: pinned ref absent fails; unpinned records HEAD commit; two builds with advancing HEAD give different commits (no caching).
4. Installer name mapping: requested name differs from installed dir, resolved via metadata; missing name fails.
5. Same skill name in two repos coexists.
6. Symlink escape rejected.
7. Config drift: change config after build, `loadSkillBundle` throws.
8. Durable: child created, orchestrator "upgrades" with a changed bundle, pod deleted; replay fails loudly on digest mismatch, and succeeds when unchanged. An existing pod is not restaged.
9. Active thread keeps frozen skills across refresh; idle thread picks up the new ones.

## Tradeoffs accepted

- We accept failing a child on bundle digest mismatch in exchange for never running with silently different skill content.
- We accept a host build step in the deploy script in exchange for no runtime network and a simple Dockerfile.
- We accept no lockfile in exchange for the agreed HEAD-at-build semantics; provenance only.

## Alternatives considered

- **Fetch at agent startup in the pod:** hides little, needs network and credentials in the sandbox; rejected by the agreed requirements.
- **Docker multi-stage build running npx:** can't see the homelab config without copying it into the tar, which duplicates the authority; also caches unpinned refs.
- **Mounting skills via ConfigMap/PVC:** breaks frozen per-child semantics and size limits.

## Open questions

- Is losing a skill on a missing-pod recreate acceptable as a hard failure, or should the image retain the previous bundle generation?
- Should the deploy script abort if config and the built manifest disagree, or only the runtime check?
- How should private repo auth (e.g. poteto/p-stack) be supplied to the host build?

## Next implementation step

Add `skillRepositories` and `skills` parsing with the duplicate and unknown-repo rejections to `src/config.ts`, with tests.
