## Scores (0–5)

| Criterion | A (host bundle) | B (Docker resolver + image digest) |
|---|---|---|
| 1. Config/build semantics | 4 | 4 |
| 2. Deep small interface / fit | 3 | 3 |
| 3. Frozen per-child assignment across upgrades | 3 | 3 |
| 4. Boundary/security | 4 | 3 |
| 5. Tests / order / CLI evidence | 4 | 3 |
| **Total** | **18** | **16** |

## Criterion notes

**1. Semantics.**
- A re-resolves on every deploy by deleting `outDir` and rebuilding before `docker build`. The config is read from the exact homelab file, so there is one authority.
- B gets the same effect with a `SKILLS_REFRESH` arg. That works, but the config has to be snapshotted into a temp context, and the plan is vague about how.
- Both reject duplicate repos and fail on pinned refs that are absent.

**2. Interface.**
- A has a clean split: `buildSkillBundle`, `loadSkillBundle`, `freeze`, `promptFor` and `stage`. But callers must coordinate `freeze`, `promptFor` and `stage`.
- B's `open`/`bind` is leaner. It then adds heavy branded types and a parallel `SandboxState.imageDigest` redesign of `sandboxPod`.
- B's "legacy state adopt pod's actual image" and "ownerless threads get sandboxes" expand scope considerably.

**3. Frozen assignment.** Both are weaker than they look (see must-fix issues).

**4. Security.**
- A scrubs the installer env, validates argv inputs and rejects symlink escapes.
- B uses BuildKit secrets, which is good. However, it executes third-party git and npx inside Docker on the homelab builder, and it leaves the "private repo auth" mechanism underspecified.
- B also says nothing about env scrubbing.

**5. Tests.**
- A lists nine concrete tests, including a drift test and a durable replay test.
- B's tests are good but more narrative. Its "registry retention" risk is only noted, not tested.

## Must-fix issues

**Surviving old sandbox vs current Kaeno files.**
- A stages skills into `/workspace/.agents/skills` through envd, so a surviving pod keeps its own copy. This is the right idea.
- But `stage()` is described as idempotent and "not touched" for existing pods. It needs a marker or digest file in the workspace; otherwise it cannot tell whether a partial copy is complete after a crash mid-stage.
- The workspace is an emptyDir, so a pod restart in place loses files. Kaeno's prompt would still point at paths that no longer exist. Staging has to be re-verified on every env connect, not only on first configure.
- B keeps skills in the image at `/opt/kaeno/skills`. A surviving pod therefore reads its own old image, which is consistent. But the prompt comes from the persisted binding, and nothing checks that the old image actually contains those paths.

**Missing-pod recreation image.**
- This is the core replay risk. A fails loudly on digest mismatch, which is safe but makes the child unrecoverable after any skill change.
- B persists `imageDigest` and recreates the pod from it. This is the stronger design, because it preserves the whole sandbox environment (envd version, node) as well as the skills.
- B's costs are registry retention and the fact that envd code at the old digest must still talk to the new orchestrator. That compatibility risk is unacknowledged.
- A's alternative is to freeze the content, not just the digest. For example, store the skill tree in the harness SQLite or retain bundle generations. A does not do this.

**Durable snapshot limits.**
- Neither stores skill content in durable state, only identity and digest. Durability therefore depends on an external artifact: the image (B) or the retained bundle (A).
- A's `FrozenSkills` carries no description, so `promptFor` needs the current manifest. That contradicts "never from current".
- B stores descriptions in the binding, which is better.

**Setup API viability.**
- A's `deploy.sh` runs a host script that needs `npx`, git and private auth on the deploy machine.
- B's Docker-internal `npx` and git need network access inside the build, plus secrets plumbing through the ssh-to-homelab tar flow. Neither has been verified against `poteto/p-stack`, which was unreachable.
- Both are unverified against the CLI's local-path install. This needs a spike first.
- A's `.skill-bundle` must also survive the `.dockerignore` and tar steps. That is noted but not tested.

## Recommendation

**Base: A**, for its host build, single config authority, concrete test list and the closest fit to the existing deploy flow.

**Grafts (max 3):**
1. **From B:** persist `imageDigest` in `AgentState.sandbox` and recreate missing pods from it, failing visibly if the image is gone. This replaces A's "fail on mismatch" with real replay consistency.
2. **From B:** store descriptions and entrypoints in the persisted binding, so prompts never read the current manifest.
3. **From B:** idle-boundary thread migration, plus a pinned-installer check. Add A's workspace marker so `stage()` re-verifies on every connect.
