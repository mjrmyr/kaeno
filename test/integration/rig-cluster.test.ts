import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRigCluster } from "../rig/cluster.ts";

it("preserves edits within a worker and on adoption, but gives new workers fresh workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaeno-rig-cluster-"));
  const cluster = createRigCluster(root);
  const pod = {
    metadata: { name: "rig-first" },
    spec: {
      containers: [
        {
          env: [{ name: "KAENO_ENV_TOKEN", value: "rig-token".repeat(4) }],
        },
      ],
    },
  };
  try {
    await cluster.client.createPod(pod);
    const marker = join(root, "workspace", "marker.txt");
    await writeFile(marker, "keep on adoption");
    const first = cluster.pod("rig-first");
    await cluster.client.createPod(pod);
    expect(cluster.pod("rig-first")).toBe(first);
    expect(await readFile(marker, "utf8")).toBe("keep on adoption");
    await appendFile(marker, "\nedited within the same worker");
    expect(await readFile(marker, "utf8")).toBe(
      "keep on adoption\nedited within the same worker",
    );

    const next = { ...pod, metadata: { name: "rig-next" } };
    await expect(cluster.client.createPod(next)).rejects.toThrow(
      "one sandbox at a time",
    );
    await cluster.client.deletePod("rig-first");
    await cluster.client.createPod(next);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(cluster.pod("rig-next")?.workspace).toBe(join(root, "workspace"));
  } finally {
    await cluster.stop();
    await rm(root, { recursive: true, force: true });
  }
});
