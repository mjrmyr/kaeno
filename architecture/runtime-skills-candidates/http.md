## Problem

Move skill resolution from image builds to startup while retaining immutable, durable bindings and assigned-only worker filesystems. This candidate uses a persistent content-addressed cache and authenticated HTTP delivery to worker init containers. It requires changing the current worker→kaeno network prohibition: init and main share a Pod IP, so NetworkPolicy cannot grant access to init alone.

## Usage (caller’s view)

```ts
// src/kaeno.ts — preparation must succeed before Harness.resume.
const runtime = await prepareSkillRuntime({
  repositories: config.skillRepositories,
  cacheRoot: "/skill-cache",
  installerEnv: dedicatedInstallerEnv,
});
const catalog = runtime.catalog;
const delivery = await serveSkillArtifacts(runtime.store, deliveryOptions);
await harness.resume();
```

```ts
// src/agents.ts — persist binding and image atomically before pod creation.
const child = await tasks.createChild({
  skillBinding: catalog.bind(requestedSkills),
  sandboxImage: genericWorkerImage,
  skillSource: { kind: "runtime-cache", format: 1 },
});

await workers.ensurePod(child, delivery);
```

```ts
// Generic init executable — fetch only this pod's authorized selection.
await materializeAssignedSkills({
  endpoint: process.env.SKILL_DELIVERY_URL!,
  tokenFile: "/var/run/skill-delivery/token",
  destination: "/assigned-skills",
});
```

## Shape

### Durable data

```ts
type TreeDigest = string & { readonly __treeDigest: unique symbol };
type SelectionDigest = string & { readonly __selectionDigest: unique symbol };

// Existing bounded BoundSkill documents retain their domain semantics.
interface ArtifactSelection {
  readonly format: 1;
  readonly digest: SelectionDigest;
  readonly entries: readonly {
    readonly skill: BoundSkill;
    readonly tree: TreeDigest;
    readonly mountPath: string;
  }[];
}

type DurableSkillSource =
  | { readonly kind: "runtime-cache"; readonly format: 1 }
  | { readonly kind: "legacy-image"; readonly image: string };

interface DurableChildSkills {
  readonly binding: ArtifactSelection;
  readonly source: DurableSkillSource;
  readonly sandboxImage: string;
}

// Ephemeral authorization; not part of durable task state.
interface DeliveryGrant {
  readonly taskId: string;
  readonly podUid: string;
  readonly selection: SelectionDigest;
  readonly expiresAt: number;
}
```

### Preparation and storage

```ts
interface SkillArtifactStore {
  // Validates canonical paths, file kinds, limits and tree digest.
  // Publishes by atomic rename from unique staging; never overwrites.
  publish(stagingDirectory: string): Promise<TreeDigest>;

  // Opens only completed, verified immutable trees.
  open(tree: TreeDigest): Promise<VerifiedTree>;
}

interface PreparedSkillRuntime {
  readonly catalog: SkillCatalog;
  readonly store: SkillArtifactStore;
}

declare function prepareSkillRuntime(options: {
  repositories: readonly RepositorySpec[];
  cacheRoot: string;
  installerEnv: Readonly<Record<string, string>>;
}): Promise<PreparedSkillRuntime>;
```

Startup resolves Git refs, runs installation with a credential-free environment except explicitly permitted installer settings, validates content, and publishes trees before constructing the catalogue. Git credentials belong exclusively to the resolver. Cache hits are validated at this trust boundary; abandoned staging is reclaimable, completed trees are not garbage-collected.

### Delivery and init

```ts
interface SkillDelivery {
  // Called after Kubernetes assigns the pod UID.
  // Creates a short-lived, pod-specific bearer capability.
  issueGrant(input: {
    taskId: string;
    podUid: string;
    selection: SelectionDigest;
  }): Promise<{ token: string; expiresAt: number }>;

  revokePod(podUid: string): Promise<void>;
}

declare function serveSkillArtifacts(
  store: SkillArtifactStore,
  options: DeliveryOptions,
): Promise<SkillDelivery>;

declare function materializeAssignedSkills(options: {
  endpoint: string;
  tokenFile: string;
  destination: string;
}): Promise<void>;
```

**Protocol:** `GET /v1/assigned-skills`, authenticated over TLS. The token identifies a grant; the request accepts no caller-selected task IDs, digests, paths, or repository URLs. The server loads the durable selection and streams only its manifest and selected trees. Tokens are reusable until expiry to permit interrupted-download retries.

The pod is created with init waiting for its token. After receiving its UID, the controller issues the grant and creates the referenced token Secret. Restart reconciliation reissues expired grants for unfinished init; server restart invalidates ephemeral grants without invalidating durable bindings.

Init independently validates manifest limits, safe paths, file kinds and tree digests, then atomically publishes the complete selection into an `emptyDir`. Main mounts only that directory, read-only. Only init mounts the token Secret; neither container mounts the cache PVC. Delivery never exposes Git credentials, cache paths, or unselected trees.

New children persist cache-backed bindings and generic image pins. Replay reads those bindings—not the current catalogue—and recreates grants against retained trees. Missing durable artifacts fail closed; replay never substitutes newly resolved content. Legacy children retain their pinned source-image initialization path.

**Interface depth:** preparation hides Git/install/publication mechanics; delivery hides authorization and artifact framing; init hides transfer and extraction. Callers expose only repository configuration, durable selections and pod lifecycle identity. Persistence ordering remains visible because it is a caller-owned transaction invariant.

## Synthesis decision

Use persistent content-addressed storage as the durability base, with authenticated selected-artifact delivery replacing direct PVC copying. Prefer this candidate only if separating workers from cache storage justifies a new service boundary and the network-policy relaxation.

## Tradeoffs accepted

- We accept an HTTP/TLS service and grant lifecycle in exchange for workers having no cache-volume access.
- We accept main-container network reachability to the delivery port in exchange for HTTP init delivery; authorization, not NetworkPolicy, enforces selection isolation.
- We accept retained immutable artifacts without GC in exchange for reliable durable replay.
- We accept pod creation followed by token issuance in exchange for binding authorization to an actual pod UID.
- We accept startup unavailability on resolution failure in exchange for admitting no turns against an incomplete catalogue.

## Alternatives considered

- **Dedicated cache PVC mounted only by init:** similarly deep caller interface, with copying hidden behind pod construction; avoids HTTP authorization and preserves worker network policy. Loses when cache topology or storage exposure to init is unacceptable.
- **Init fetches Git/npm directly:** exposes resolution, credentials and mutable-ref behavior to every worker lifecycle. It hides central delivery infrastructure but violates reproducible replay and multiplies preparation boundaries.
- **Image-baked catalogue:** hides artifact transport effectively, but exposes configuration changes as image releases and cannot satisfy runtime/image independence.

## Open questions and risks

- Is main-container reachability to a dedicated kaeno delivery port acceptable, despite its inability to obtain the init-only token through supported mounts?
- Should delivery run in kaeno or a separate service to reduce the attack surface reachable by workers?
- What TLS identity, transfer limits and grant lifetime fit deployment operations and expected artifact sizes?
- Is indefinite artifact retention acceptable until a durable-reference-aware GC design is approved?

## Next implementation step

Define and test the canonical tree and selection formats, atomic cache publication, and init verification against malformed artifacts before wiring startup or HTTP delivery.
