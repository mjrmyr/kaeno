import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { required } from "./values.ts";
// Execute the actual workflow shell with fake API/registry boundaries. No login,
// image build/push, or GitHub Actions run is performed by these tests.
const stepSchema = z.object({
  id: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  with: z
    .object({
      flavor: z.string().optional(),
      tags: z.string().optional(),
      draft: z.boolean().optional(),
      "build-args": z.string().optional(),
    })
    .passthrough()
    .default({}),
});
const jobSchema = z.object({
  steps: z.array(stepSchema),
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  outputs: z.record(z.string(), z.string()).optional(),
  concurrency: z.unknown().optional(),
});
const workflow = z
  .object({
    on: z.object({
      push: z.object({
        branches: z.array(z.string()),
        tags: z.array(z.string()),
      }),
    }),
    jobs: z.object({
      publish: jobSchema,
      "promote-main": jobSchema,
      "homelab-pr": jobSchema,
    }),
    concurrency: z.unknown().optional(),
  })
  .parse(
    parse(
      await readFile(
        new URL("../../.github/workflows/publish-images.yml", import.meta.url),
        "utf8",
      ),
    ),
  );
const publish = workflow.jobs.publish;
const promote = workflow.jobs["promote-main"];
const promotion = required(promote.steps.find((step) => step.run));
const homelab = workflow.jobs["homelab-pr"];
const current = "a".repeat(40);
const old = "b".repeat(40);
const sandboxDigest = `sha256:${"c".repeat(64)}`;
const kaenoDigest = `sha256:${"d".repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function runPromotion({
  sha = current,
  head = current,
  apiFailure = false,
  registryFailure = "",
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-promotion-"));
  directories.push(directory);
  const log = join(directory, "calls");
  const output = join(directory, "output");
  await writeFile(output, "");
  await writeFile(
    join(directory, "gh"),
    `#!/bin/bash
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
[[ "$API_FAILURE" != true ]] || exit 1
printf '%s\\n' "$MAIN_HEAD"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(directory, "docker"),
    `#!/bin/bash
printf 'docker %s\\n' "$*" >> "$CALL_LOG"
[[ -z "$REGISTRY_FAILURE" || "$*" != *"$REGISTRY_FAILURE"* ]] || exit 1
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", required(promotion.run)], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      CALL_LOG: log,
      GITHUB_REPOSITORY: "mjrmyr/kaeno",
      GITHUB_SHA: sha,
      MAIN_HEAD: head,
      GITHUB_OUTPUT: output,
      SANDBOX_DIGEST: sandboxDigest,
      KAENO_DIGEST: kaenoDigest,
      API_FAILURE: String(apiFailure),
      REGISTRY_FAILURE: registryFailure,
    },
  });
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  return {
    result,
    calls,
    writes: calls.filter((line) => line.startsWith("docker ")),
    output: await readFile(output, "utf8"),
  };
}
it("builds keep SHA/version tags, but only the serialized main-only job can write aliases", () => {
  expect(workflow.on.push).toEqual({ branches: ["main"], tags: ["**"] });
  expect(promote.if).toBe("github.ref == 'refs/heads/main'");
  expect(promote.needs).toBe("publish");
  expect(promote.concurrency).toEqual({
    group: "ghcr-main-aliases",
    "cancel-in-progress": false,
  });
  expect(workflow.concurrency).toBeUndefined();
  expect(publish.concurrency).toBeUndefined(); // Don't cancel immutable builds either.
  const metadata = publish.steps.filter((step) => step.id?.endsWith("-meta"));
  expect(metadata).toHaveLength(2);
  for (const step of metadata) {
    expect(step.with.flavor).toBe("latest=false");
    expect(required(step.with.tags).trim().split("\n")).toEqual([
      "type=sha,format=short,prefix=sha-",
      "type=ref,event=tag",
    ]);
  }
  expect(publish.outputs).toEqual({
    "sandbox-digest": "${{ steps.sandbox.outputs.digest }}",
    "kaeno-digest": "${{ steps.kaeno.outputs.digest }}",
  });
  expect(promotion.env.SANDBOX_DIGEST).toBe(
    "${{ needs.publish.outputs.sandbox-digest }}",
  );
  expect(promotion.env.KAENO_DIGEST).toBe(
    "${{ needs.publish.outputs.kaeno-digest }}",
  );
  expect(
    required(publish.steps.find((step) => step.id === "kaeno")).with[
      "build-args"
    ],
  ).toBe(
    "SANDBOX_IMAGE=ghcr.io/mjrmyr/kaeno-sandbox@${{ steps.sandbox.outputs.digest }}\n",
  );
});
it("checks live main before promoting the exact digest pair to all four aliases", async () => {
  const { result, calls, writes, output } = await runPromotion();
  expect(output).toBe("promoted=true\n");
  expect(result.status).toBe(0);
  expect(calls[0]).toBe(
    "gh api repos/mjrmyr/kaeno/git/ref/heads/main --header Cache-Control: no-cache --jq .object.sha",
  );
  expect(writes).toEqual([
    `docker buildx imagetools create --prefer-index=false --tag ghcr.io/mjrmyr/kaeno-sandbox:main --tag ghcr.io/mjrmyr/kaeno-sandbox:latest ghcr.io/mjrmyr/kaeno-sandbox@${sandboxDigest}`,
    `docker buildx imagetools create --prefer-index=false --tag ghcr.io/mjrmyr/kaeno:main --tag ghcr.io/mjrmyr/kaeno:latest ghcr.io/mjrmyr/kaeno@${kaenoDigest}`,
  ]);
});
it("skips an old build or retry without any alias writes", async () => {
  const { result, writes, output } = await runPromotion({ sha: old });
  expect(output).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Skipping aliases");
  expect(writes).toEqual([]);
});
it("fails closed if the live HEAD API fails", async () => {
  const { result, writes, output } = await runPromotion({ apiFailure: true });
  expect(output).toBe("");
  expect(result.status).not.toBe(0);
  expect(writes).toEqual([]);
});
it("does not promote on an empty HEAD response", async () => {
  const { result, writes, output } = await runPromotion({ head: "" });
  expect(output).toBe("");
  expect(result.status).toBe(0);
  expect(writes).toEqual([]);
});
it("an out-of-order old retry cannot undo a newer promotion", async () => {
  expect((await runPromotion({ sha: old, head: old })).writes).toHaveLength(2);
  const retry = await runPromotion();
  expect(retry.writes).toHaveLength(2);
  expect(retry.output).toBe("promoted=true\n");
  expect((await runPromotion({ sha: old })).writes).toEqual([]);
});
it("stops if sandbox promotion fails, and a current-main retry writes the whole pair", async () => {
  const failed = await runPromotion({ registryFailure: "kaeno-sandbox:main" });
  expect(failed.result.status).not.toBe(0);
  expect(failed.output).toBe("");
  expect(failed.writes).toHaveLength(1);
  const retry = await runPromotion();
  expect(retry.writes).toHaveLength(2);
  expect(retry.output).toBe("promoted=true\n");
});
it("a partial pair is repaired by current-main retry, never by an old retry", async () => {
  const failed = await runPromotion({
    registryFailure: "--tag ghcr.io/mjrmyr/kaeno:main",
  });
  expect(failed.result.status).not.toBe(0);
  expect(failed.output).toBe("");
  expect(failed.writes).toHaveLength(2); // Sandbox succeeded; kaeno was attempted.
  expect((await runPromotion({ sha: old })).writes).toEqual([]);
  const retry = await runPromotion();
  expect(retry.writes).toHaveLength(2);
  expect(retry.output).toBe("promoted=true\n");
});
it("exposes completed promotion without restoring the separate source/base recheck", () => {
  expect(promotion.id).toBe("promotion");
  expect(promote.outputs).toEqual({
    promoted: "${{ steps.promotion.outputs.promoted }}",
  });
  expect(homelab.needs).toEqual(["publish", "promote-main"]);
  expect(homelab.steps.some((step) => step.id === "current")).toBe(false);
  expect(homelab.steps.some((step) => step.run?.includes("gh api"))).toBe(
    false,
  );
  const proposal = required(
    homelab.steps.find((step) =>
      step.uses?.startsWith("peter-evans/create-pull-request@"),
    ),
  );
  expect(proposal.if).toBe("steps.image.outputs.changed == 'true'");
  expect(proposal.with.draft).toBe(false);
});
it("requires successful main publish AND actual promotion for follow-up automation (432 gate cases)", () => {
  // This gate uses only JS-compatible comparisons/booleans; bracket the hyphenated job ID.
  const eligible = new Function(
    "github",
    "needs",
    `return (${required(homelab.if).replaceAll("needs.promote-main", 'needs["promote-main"]')});`,
  );
  let cases = 0;
  for (const event of ["push", "pull_request", "workflow_dispatch"]) {
    for (const ref of [
      "refs/heads/main",
      "refs/heads/ci/homelab-image-pr",
      "refs/tags/v1.0.0",
    ]) {
      for (const published of ["success", "failure", "cancelled", "skipped"]) {
        for (const promoted of ["success", "failure", "cancelled", "skipped"]) {
          for (const output of ["true", "false", undefined]) {
            expect(
              eligible(
                { event_name: event, ref },
                {
                  publish: { result: published },
                  "promote-main": {
                    result: promoted,
                    outputs: { promoted: output },
                  },
                },
              ),
            ).toBe(
              event === "push" &&
                ref === "refs/heads/main" &&
                published === "success" &&
                promoted === "success" &&
                output === "true",
            );
            cases++;
          }
        }
      }
    }
  }
  expect(cases).toBe(432);
});
