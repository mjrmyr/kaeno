# Candidate A: Runtime skill cache PVC, init-only mount

## Problem

Skill config is currently a build input: `deploy.sh` → `build-skills.ts` → image COPY → k8s init copies from a source image. We need config as runtime data with generic images, assigned-only worker visibility, and durable replay of old bindings. Constraints honored: worker→kaeno network stays closed; the SQLite PVC must not be exposed to init; startup failure precedes `Harness.resume`; immutable trees are never GC'd while durable tasks may reference them; installer env excludes credentials; no new source-image bindings.

## Usage (caller's view)

Startup (`src/kaeno.ts`):
```ts
const cache = await SkillCache.open({ root: "/skill-cache" });        // kaeno mounts RW
const manifest = await prepareSkills(config.repositories, cache);     // resolve, install, hash, publish
const catalog = SkillCatalog.fromManifest(manifest, cache);
await Harness.resume(...);                                            // only after success
```
Child creation (`src/agents.ts`):
```ts
const binding = catalog.bind(selectedSkillNames);   // atomic with sandbox image capture
await sandbox.create({ image: genericImage, skills: binding.trees });
```
Pod (`src/k8s.ts`): init mounts the cache PVC RO, copies only `binding.trees` into an `emptyDir`; the main container mounts that emptyDir RO.

## Shape

**Data**
```ts
type TreeId = `sha256:${string}`;                 // content hash of skill tree
interface PublishedTree { id: TreeId; path: string; commit: string; source: RepositorySpec }
interface SkillManifest { skills: Record<SkillName, PublishedTree>; resolvedAt: string }

type SkillBinding =                               // persisted in AgentState
  | { kind: "tree"; skill: SkillName; tree: TreeId }
  | { kind: "legacy-image"; skill: SkillName; image: string; hash: string }; // replay only, never created
```

**Signatures**
```ts
interface SkillCache {
  static open(o: { root: string }): Promise<SkillCache>;
  publish(staged: StagedTree): Promise<PublishedTree>;  // rename(staging → trees/<hash>), idempotent
  has(id: TreeId): Promise<boolean>;
  verify(id: TreeId): Promise<void>;                    // hash recheck, used at bind
}
prepareSkills(repos: RepositorySpec[], cache: SkillCache): Promise<SkillManifest>;
// resolve ref → commit; git/npx in a scrubbed env; preflight; hash; publish; clean stale staging
podSkillInit(binding: SkillBinding[]): InitContainerSpec;   // trusted shape, args = tree ids only
```

**Layout**: `/skill-cache/trees/<hash>/` (immutable, 0555), `/skill-cache/staging/<uuid>/` (unique, cleaned on retry). No manifest-of-record on the PVC; bindings in SQLite are the durable authority.

**Flow**: config → `prepareSkills` (startup, kaeno-owned) → immutable trees on the cache PVC → bind persists `TreeId`s → init copies those trees only → readonly worker mount. Replay reads the binding's `TreeId`, never the current manifest. Legacy bindings go through a read-only compat branch in `podSkillInit`.

**Invariants in types/boundaries**
- Git/npx/hash validation happens only in `prepareSkills`, and the init copy re-verifies the hash. Internal bindings are trusted.
- The init container receives tree IDs, validated by pattern, so it cannot traverse the cache.
- Hash-addressed publish makes retries idempotent. There is no GC; trees are retained.
- The installer env is allowlisted (no provider/bot/API/Git creds). Runtime Git credentials are an optional dedicated read-only token, never worker deploy keys.

**Interface depth**: callers see `prepareSkills` and `bind`. Hidden: resolution, installation, hashing, staging, atomic publish, and the PVC layout. Exposed: only `TreeId`.

## Synthesis decision

(Filled in by arena.)

## Tradeoffs accepted

- We accept RWO/local-path node binding in exchange for no new network paths or services (fine on the single-node homelab).
- We accept unbounded tree retention in exchange for safe durable replay; GC is deferred.
- We accept that kaeno mounts the cache RW and init mounts it RO, in exchange for the main container and the SQLite PVC staying isolated from init.
- We accept startup latency from `prepareSkills`, in exchange for failing before any turn is admitted.

## Alternatives considered

- **Authenticated artifact endpoint on kaeno**: init fetches trees over HTTP. It loses on interface depth: it adds a protocol, auth and a worker→kaeno network opening, which breaks the isolation invariant.
- **Share the SQLite PVC with init**: simpler, but it exposes unrelated durable data to init. Forbidden.
- **Per-agent fetch inside init (Git/npx in the pod)**: creates a second fetching path and gives workers egress and credentials. Rejected.

## Open questions and risks

- Should a binding verify the hash at bind time, at init time, or both (cost vs. tamper detection)?
- What is the size and retention policy for the cache PVC without GC? Is a manual-prune tool enough?
- Does the cache PVC's fsGroup 10001 let init read while still blocking main? (The main container must not mount it at all.)
- How long should legacy-image replay be supported?

## Next implementation step

Implement `SkillCache.publish` and `prepareSkills` with staging and hash-addressed rename, and tests for crash/retry idempotency.
