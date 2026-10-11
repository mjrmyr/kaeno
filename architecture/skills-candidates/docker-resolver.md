## Problem

Skills must be resolved during image builds without giving Kaeno host filesystem, shell, or credential access. Repository identity and skill identity are separate: repository refs affect resolution; template selections remain versionless. Durable agents must retain both their assigned skills and their sandbox image across upgrades, including when a missing pod is recreated.

## Usage (caller’s view)

Configuration remains declarative:

```json
{
  "skillRepositories": [
    "poteto/p-stack:v0.2.4",
    "mattpocock/skills"
  ],
  "templates": {
    "worker": {
      "skills": [
        "poteto/p-stack:poteto-mode",
        "mattpocock/skills:grill-me"
      ]
    }
  }
}
```

Deployment snapshots the sibling homelab configuration into a temporary Docker context. Resolution and installation occur **inside Docker**, not on the host:

```sh
docker build \
  --build-arg SKILLS_REFRESH="$(uuidgen)" \
  --secret id=skill_git_auth,src="$BUILD_AUTH_FILE" \
  -t "$IMAGE" "$TEMP_CONTEXT"
```

Runtime validates that the image supports the configured selections before resuming:

```ts
const skills = await SkillCatalog.open("/opt/kaeno/skills", config);
await refreshThreads({ config, skills, imageDigest });
await harness.resume();
```

New agents bind once; replay uses persisted state:

```ts
const binding = skills.bind(template.skills);
const state = { template: template.name, sandbox: { imageDigest }, skills: binding };
// Persist state with child creation before configuring it.
```

Sandbox recreation uses that child’s digest, never the orchestrator’s current image.

## Shape

### Core domain types

```ts
type RepositoryId = string & { readonly __repository: unique symbol };
type SkillId = string & { readonly __qualifiedSkill: unique symbol };
type Commit = string & { readonly __commit: unique symbol };
type ImageDigest = string & { readonly __imageDigest: unique symbol };
type BundleDigest = string & { readonly __bundleDigest: unique symbol };
type BundlePath = string & { readonly __containedPath: unique symbol };

interface SkillRepository {
  id: RepositoryId;
  ref?: string; // Absent means remote default-branch HEAD.
}

interface SkillSpec {
  repositories: readonly SkillRepository[];
  selections: Readonly<Record<string, readonly SkillId[]>>; // Template name.
}

interface InstalledSkill {
  id: SkillId;
  repositoryCommit: Commit;
  directory: BundlePath;
  entrypoint: BundlePath;
  description: string;
}

interface SkillManifest {
  schema: 1;
  spec: SkillSpec;
  bundleDigest: BundleDigest;
  installer: "skills@1.7.2";
  skills: readonly InstalledSkill[];
}

interface SkillBinding {
  bundleDigest: BundleDigest;
  skills: readonly InstalledSkill[]; // Immutable serialized snapshot.
}

interface SandboxState {
  imageDigest: ImageDigest;
  pod: string;
  token: string;
}

interface AgentState {
  template: string;
  sandbox?: SandboxState;
  skills: SkillBinding;
}
```

Only boundary parsers construct branded values. JSON remains an implementation detail.

### Module interfaces

```ts
// src/skills.ts
export class SkillCatalog {
  /** Validate manifest, bundle integrity, and current skill configuration. */
  static open(root: string, config: Config): Promise<SkillCatalog>;

  /** Preserve configured order; reject unknown qualified selections. */
  bind(selection: readonly SkillId[]): SkillBinding;
}

/** Pure: render persisted descriptions and sandbox-visible SKILL.md paths. */
export function skillInstructions(binding: SkillBinding): string;

// scripts/build-skills.ts — executed only in the resolver stage
export function buildSkills(
  configSnapshot: string,
  outputDirectory: string,
): Promise<void>;

// src/k8s.ts — extend existing API, not a parallel provisioning service
export function sandboxPod(
  state: SandboxState,
): PodSpec;
```

`src/config.ts` parses repository/version syntax and qualified selections, rejecting duplicate repository identities even with different refs. `src/agents.ts` binds skills and persists the image digest at creation. `src/threads.ts` owns thread migration. `src/kaeno.ts` validates before resume. No additional runtime resolver exists.

### Docker build boundary

The resolver stage receives the configuration snapshot and pinned installer. It references `SKILLS_REFRESH` in the resolution `RUN`, invalidating that layer and its descendants on **every deploy build**. Thus an unpinned repository is re-resolved even when Docker otherwise has reusable layers.

For each repository:

1. Fetch its specified ref or advertised default branch; fail if absent. Record the exact commit.
2. Check out that commit once.
3. Run `npx skills@1.7.2 add <absolute-checkout>` with separate argv elements, selected names, `--agent pi --copy --yes`, inside an isolated project directory.
4. Scan installed `SKILL.md` metadata; match names rather than guessing sanitized destinations.
5. Copy into repository-qualified bundle directories and emit the manifest.

Reject missing or ambiguous names, escaping paths, symlinks, and special files. Check that installed entrypoints and referenced local assets survive installation. Repository isolation prevents installer-name collisions across repositories.

The final stage copies only the verified bundle into `/opt/kaeno/skills`. Git credentials use ephemeral BuildKit secrets; neither credentials nor checkouts enter runtime layers. The temporary context explicitly includes the snapshot regardless of deploy tar exclusions. No lockfile controls subsequent builds.

The catalog hides provenance parsing, compatibility checks, and path validation behind two operations: open and bind. This follows boundary discipline and favors interface depth over exposing resolver machinery.

## Lifecycle across upgrades

- **New child:** atomically persist binding, sandbox token, and current immutable image digest with creation. Configure from that persisted assignment.
- **Surviving child:** retain its old pod and assignment. Never consult current host files to regenerate its skill prompt.
- **Missing child pod:** recreate using its persisted digest. If unavailable, fail visibly; never substitute the new image.
- **Threads:** refresh model/instructions under existing policy, but change skills only at an idle conversation boundary. Persist the replacement binding and sandbox generation together; active threads defer migration.
- **Legacy state:** adopt the existing pod’s actual immutable image only after verifying its bundle. Missing legacy pods require explicit migration rather than guessing.
- **Skill-capable ownerless threads:** provision a sandbox through the same lifecycle before activation. Reject skill assignments without sandbox/read capability; skills never grant tools or credentials.

## Synthesis decision

Candidate B proposes image-contained bundles and persisted image identity as the base; final synthesis is left to the arena.

## Tradeoffs accepted

- We accept full skill-related rebuilds for reliable unpinned resolution.
- We accept retaining old image digests for deterministic replay.
- We accept rejecting symlinks for a simpler containment boundary.
- We accept idle-boundary thread migration instead of immediate skill refresh.

## Alternatives considered

- **Host-assembled bundle:** exposes installer/auth/context coordination to deployment callers; Docker isolation hides these behind one build boundary.
- **Startup installation:** hides packaging but exposes network, credential, and mutable-resolution failures to every runtime; it violates build-time resolution.
- **Separate bundle service:** decouples images but requires another durable asset-retrieval protocol. Image pinning already solves that responsibility.

## Tests and implementation order

Start with pure configuration and manifest validation. Then test the resolver with local Git fixtures: exact refs, nonexistent refs, advancing default branches across cached builds, duplicate repositories, ambiguous names, missing assets, and malicious paths.

Verify the pinned CLI’s local-install behavior against fixtures and a public repository. Test configuration drift, interrupted builds, and secret-free runtime layers.

Finally, run a fake model through real envd: read assigned `SKILL.md`, execute its bundled script, crash/reopen, upgrade the orchestrator, delete the child pod, and verify recreation uses the old digest. Test deferred thread migration separately.

## Open questions and risks

- How long will the registry retain images needed by durable children?
- Should third-party scripts require an additional review gate despite receiving no extra permissions?

## Next implementation step

Build the pure skill-config parser and manifest contract with failing fixture tests before changing Docker or runtime lifecycle code.
