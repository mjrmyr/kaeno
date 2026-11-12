import { describe, it, expect } from "vitest";
import {
  KubernetesObserver,
  ObservationClient,
  projectKubernetesObservation as projectFact,
  kubernetesObservationFactSchema as factSchema,
  KUBERNETES_OBSERVATION_KINDS as kinds,
  assessKubernetesObservation as assess,
} from "../index.ts";

const canary = "CANARY-secret-token-never-export";
const time = new Date("2026-01-02T03:04:05.000Z");
const scope = { namespaces: ["pilot"] };
function rawPod() {
  return {
    metadata: {
      name: "web",
      namespace: "pilot",
      labels: { secret: canary },
      annotations: { secret: canary },
    },
    spec: {
      containers: [
        {
          name: "web",
          env: [{ value: canary }],
          command: [canary],
          image: canary,
        },
      ],
    },
    status: {
      phase: "Running",
      message: canary,
      conditions: [{ type: "Ready", status: "False", message: canary }],
      containerStatuses: [
        {
          name: "web",
          ready: false,
          restartCount: 3,
          state: { waiting: { reason: canary, message: canary } },
        },
      ],
    },
  };
}
async function fixture() {
  const observer = new KubernetesObserver(
    scope,
    async (path) => ({ items: path.includes("/pods?") ? [rawPod()] : [] }),
    () => time,
  );
  await observer.poll();
  return observer;
}

describe("privacy projection", () => {
  it("constructs only approved facts and maps arbitrary reason strings to Other", () => {
    const fact = projectFact("Pod", "pilot", rawPod());
    expect(JSON.stringify(fact)).not.toContain(canary);
    expect(fact.containers[0]).toMatchObject({
      reason: "Other",
      ready: false,
      restarts: 3,
    });
    expect(assess(fact)).toBe("Unhealthy");
    expect(factSchema.safeParse({ ...fact, message: canary }).success).toBe(
      false,
    );
  });
  it.each(kinds)(
    "projects %s without free text, missing evidence stays unknown",
    (kind) => {
      const fact = projectFact(kind, kind === "Node" ? null : "pilot", {
        ...rawPod(),
        status: { phase: canary, message: canary, reason: canary },
        spec: {
          schedule: canary,
          resources: { requests: { storage: canary } },
        },
      });
      expect(JSON.stringify(fact)).not.toContain(canary);
      expect(assess(fact)).toBe("Unknown");
    },
  );
  it("bounds containers and marks incomplete status", () => {
    const pod = rawPod();
    pod.status.containerStatuses = Array.from({ length: 65 }, (_, index) => ({
      ...pod.status.containerStatuses[0],
      name: `web-${index}`,
    }));
    const fact = projectFact("Pod", "pilot", pod);
    expect(fact.containers).toHaveLength(64);
    expect(fact.containersIncomplete).toBe(true);
    expect(assess(fact)).toBe("Unknown");
  });
  it("checks namespace scope and identifiers before returning any fact", () => {
    expect(() => projectFact("Pod", "other", rawPod())).toThrow();
    expect(() =>
      projectFact("Pod", "pilot", {
        metadata: { namespace: "pilot", name: "bad\nname" },
      }),
    ).toThrow();
  });
  it("preserves valid approved facts for rollout, job, cron, volume and node", () => {
    const base = {
      metadata: { name: "web", namespace: "pilot", generation: 2 },
    };
    const deployment = projectFact("Deployment", "pilot", {
      ...base,
      spec: { replicas: 2 },
      status: {
        observedGeneration: 2,
        readyReplicas: 2,
        availableReplicas: 2,
        updatedReplicas: 2,
      },
    });
    expect(assess(deployment)).toBe("Healthy");
    expect(assess({ ...deployment, observedGeneration: 1 })).toBe("Unhealthy");
    expect(assess({ ...deployment, ready: null })).toBe("Unknown");
    expect(
      projectFact("Job", "pilot", {
        ...base,
        status: { active: 0, succeeded: 1, failed: 0 },
      }),
    ).toMatchObject({ active: 0, succeeded: 1, failed: 0 });
    expect(
      projectFact("CronJob", "pilot", {
        ...base,
        spec: { schedule: "0 2 * * *", suspend: true },
        status: { active: [], lastSuccessfulTime: time.toISOString() },
      }),
    ).toMatchObject({
      schedule: "0 2 * * *",
      suspended: true,
      lastSuccessfulTime: time.toISOString(),
    });
    expect(
      projectFact("PersistentVolumeClaim", "pilot", {
        ...base,
        spec: { resources: { requests: { storage: "5Gi" } } },
        status: { phase: "Bound" },
      }),
    ).toMatchObject({ requestedCapacity: "5Gi", phase: "Bound" });
    const node = projectFact("Node", null, {
      ...base,
      status: {
        conditions: [
          "Ready",
          "MemoryPressure",
          "DiskPressure",
          "PIDPressure",
        ].map((type) => ({
          type,
          status: type === "Ready" ? "True" : "False",
          message: canary,
        })),
      },
    });
    expect(assess(node)).toBe("Healthy");
    expect(JSON.stringify(node)).not.toContain(canary);
  });
});

describe("collection and host boundary", () => {
  it("collects only allowlisted namespaces and explicitly opted-in nodes", async () => {
    const paths: string[] = [];
    const observer = new KubernetesObserver(
      scope,
      async (path) => {
        paths.push(path);
        return { items: [] };
      },
      () => time,
    );
    await observer.poll();
    expect(paths).toHaveLength(7);
    expect(paths.every((path) => path.includes("/namespaces/pilot/"))).toBe(
      true,
    );
    const nodes = new KubernetesObserver(
      { ...scope, includeNodes: true },
      async (path) => {
        paths.push(path);
        return { items: [] };
      },
      () => time,
    );
    await nodes.poll();
    expect(paths.at(-1)).toBe("/api/v1/nodes?limit=200");
  });
  it("reports partial failures without preserving raw errors or false absence", async () => {
    let fail = false;
    const observer = new KubernetesObserver(
      scope,
      async () => {
        if (fail) {
          throw new Error(canary);
        }
        return { items: [] };
      },
      () => time,
    );
    await observer.poll();
    fail = true;
    await observer.poll();
    const snapshot = observer.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(canary);
    expect(
      snapshot?.coverage.every(
        (entry) =>
          entry.state === "Invalid" &&
          entry.lastSuccessAt === time.toISOString(),
      ),
    ).toBe(true);
    const client = new ObservationClient(
      scope,
      async () => snapshot,
      () => time.getTime(),
    );
    expect(
      await client.workload({
        namespace: "pilot",
        kind: "Pod",
        name: "missing",
      }),
    ).toMatchObject({ result: "Unobserved", assessment: "Unknown" });
  });
  it("distinguishes fresh not-found from stale/unobserved and rejects out of scope before IO", async () => {
    const observer = await fixture();
    let reads = 0;
    let now = time.getTime();
    const client = new ObservationClient(
      scope,
      async () => {
        reads++;
        return observer.snapshot();
      },
      () => now,
    );
    await expect(
      client.workload({ namespace: "forbidden", kind: "Pod", name: "web" }),
    ).rejects.toThrow("forbidden");
    await expect(
      client.workload({ kind: "Node", name: "node" }),
    ).rejects.toThrow("forbidden");
    expect(reads).toBe(0);
    expect(
      await client.workload({
        namespace: "pilot",
        kind: "Pod",
        name: "missing",
      }),
    ).toMatchObject({ result: "NotFound", freshness: "Fresh" });
    now += 180_001;
    expect(
      await client.workload({
        namespace: "pilot",
        kind: "Pod",
        name: "missing",
      }),
    ).toMatchObject({ result: "Unobserved", freshness: "Stale" });
    expect(
      await client.workload({ namespace: "pilot", kind: "Pod", name: "web" }),
    ).toMatchObject({
      result: "Observed",
      assessment: "Unknown",
      freshness: "Stale",
    });
    const overview = await client.overview();
    expect(
      overview.coverage.find((entry) => entry.kind === "Pod"),
    ).toMatchObject({ healthy: 0, unhealthy: 0, unknown: 1 });
  });
  it("marks pagination incomplete and never turns an omitted page into NotFound", async () => {
    const observer = new KubernetesObserver(
      scope,
      async () => ({ items: [], metadata: { continue: canary } }),
      () => time,
    );
    await observer.poll();
    expect(JSON.stringify(observer.snapshot())).not.toContain(canary);
    const client = new ObservationClient(
      scope,
      async () => observer.snapshot(),
      () => time.getTime(),
    );
    expect(await client.overview()).toMatchObject({
      resourcesIncomplete: true,
    });
    expect(
      await client.workload({
        namespace: "pilot",
        kind: "Pod",
        name: "missing",
      }),
    ).toMatchObject({ result: "Unobserved" });
  });
  it("rejects additional remote fields, missing/duplicate coverage, scope changes and future clocks", async () => {
    const observer = await fixture();
    const valid = observer.snapshot();
    if (!valid) {
      throw new Error("Missing fixture snapshot");
    }
    for (const invalid of [
      { ...valid, secret: canary },
      { ...valid, coverage: valid.coverage.slice(1) },
      { ...valid, coverage: [...valid.coverage, valid.coverage[0]] },
      {
        ...valid,
        coverage: valid.coverage.map((entry) => ({
          ...entry,
          namespace: "other",
        })),
      },
    ]) {
      const client = new ObservationClient(
        scope,
        async () => invalid,
        () => time.getTime(),
      );
      await expect(client.overview()).rejects.toThrow("unavailable");
    }
    const future = new ObservationClient(
      scope,
      async () => ({ ...valid, observedAt: "2099-01-01T00:00:00.000Z" }),
      () => time.getTime(),
    );
    await expect(future.overview()).rejects.toThrow("unavailable");
  });
  it("reports forbidden collection and atomically replaces snapshots", async () => {
    let resolve!: (value: unknown) => void;
    let block = false;
    const observer = new KubernetesObserver(
      scope,
      async (path) => {
        if (block && path.includes("/deployments?")) {
          return new Promise((done) => {
            resolve = done;
          });
        }
        if (block) {
          throw new Error("safe upstream failure");
        }
        return { items: [] };
      },
      () => time,
    );
    await observer.poll();
    const before = observer.snapshot();
    block = true;
    const polling = observer.poll();
    expect(observer.snapshot()).toEqual(before);
    resolve({ items: [] });
    await polling;
    expect(
      observer
        .snapshot()
        ?.coverage.filter((entry) => entry.state === "Invalid"),
    ).toHaveLength(6);
  });
});

it("rejects invalid schedules and bounds upstream timestamps", () => {
  const metadata = { name: "nightly", namespace: "pilot" };
  for (const schedule of [
    "99 99 * * *",
    "* * * * *\n",
    "*/0 * * * *",
    "0 0 32 * *",
    "0 0 * 13 *",
    "0 0 * * 8",
    "3-1 * * * *",
  ]) {
    expect(
      projectFact("CronJob", "pilot", { metadata, spec: { schedule } })
        .schedule,
    ).toBeNull();
  }
  for (const schedule of ["@hourly", "*/5 0-23 1,15 * 0-7", "0 2 * * *"]) {
    expect(
      projectFact("CronJob", "pilot", { metadata, spec: { schedule } })
        .schedule,
    ).toBe(schedule);
  }
  expect(
    projectFact("CronJob", "pilot", {
      metadata,
      status: { lastSuccessfulTime: `2026-01-01T00:00:00.${"1".repeat(100)}Z` },
    }).lastSuccessfulTime,
  ).toBeNull();
});

it("bounds projected bytes and marks truncation rather than dropping evidence silently", async () => {
  const observer = new KubernetesObserver(
    scope,
    async (path) => ({
      items: path.includes("/pods?")
        ? Array.from({ length: 200 }, (_, index) => ({
            ...rawPod(),
            metadata: { name: `web-${index}`, namespace: "pilot" },
          }))
        : [],
    }),
    () => time,
  );
  await observer.poll();
  const snapshot = observer.snapshot();
  const pods = snapshot?.coverage.find((entry) => entry.kind === "Pod");
  expect(pods?.state).toBe("Truncated");
  expect(pods?.facts.length).toBeLessThan(200);
  expect(Buffer.byteLength(JSON.stringify(pods?.facts))).toBeLessThan(
    61 * 1024,
  );
});

it("never publishes a partially cancelled collection and limits requests to four lanes", async () => {
  let active = 0;
  let maximum = 0;
  const controller = new AbortController();
  const observer = new KubernetesObserver(
    scope,
    async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      controller.abort();
      return { items: [] };
    },
    () => time,
  );
  await observer.poll(controller.signal);
  expect(maximum).toBe(4);
  expect(observer.snapshot()).toBeUndefined();
});
