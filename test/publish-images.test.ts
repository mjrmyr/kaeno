import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

// Execute the actual workflow shell with fake API/registry boundaries. No login,
// image build/push, or GitHub Actions run is performed by these tests.
const workflow = parse(await readFile(new URL("../.github/workflows/publish-images.yml", import.meta.url), "utf8"));
const publish = workflow.jobs.publish;
const promote = workflow.jobs["promote-main"];
const promotion = promote.steps.find((step: any) => step.run);
const current = "a".repeat(40);
const old = "b".repeat(40);
const sandboxDigest = `sha256:${"c".repeat(64)}`;
const kaenoDigest = `sha256:${"d".repeat(64)}`;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function runPromotion({ sha = current, head = current, apiFailure = false, registryFailure = "" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-promotion-"));
  directories.push(directory);
  const log = join(directory, "calls");
  await writeFile(join(directory, "gh"), `#!/bin/bash
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
[[ "$API_FAILURE" != true ]] || exit 1
printf '%s\\n' "$MAIN_HEAD"
`, { mode: 0o755 });
  await writeFile(join(directory, "docker"), `#!/bin/bash
printf 'docker %s\\n' "$*" >> "$CALL_LOG"
[[ -z "$REGISTRY_FAILURE" || "$*" != *"$REGISTRY_FAILURE"* ]] || exit 1
`, { mode: 0o755 });
  const result = spawnSync("bash", ["-c", promotion.run], {
    encoding: "utf8",
    env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, CALL_LOG: log,
      GITHUB_REPOSITORY: "mjrmyr/kaeno", GITHUB_SHA: sha, MAIN_HEAD: head,
      SANDBOX_DIGEST: sandboxDigest, KAENO_DIGEST: kaenoDigest,
      API_FAILURE: String(apiFailure), REGISTRY_FAILURE: registryFailure,
    },
  });
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  return { result, calls, writes: calls.filter(line => line.startsWith("docker ")) };
}

it("builds keep SHA/version tags, but only the serialized main-only job can write aliases", () => {
  expect(workflow.on.push).toEqual({ branches: ["main"], tags: ["**"] });
  expect(promote.if).toBe("github.ref == 'refs/heads/main'");
  expect(promote.needs).toBe("publish");
  expect(promote.concurrency).toEqual({ group: "ghcr-main-aliases", "cancel-in-progress": false });
  expect(workflow.concurrency).toBeUndefined();
  expect(publish.concurrency).toBeUndefined(); // Don't cancel immutable builds either.
  const metadata = publish.steps.filter((step: any) => step.id?.endsWith("-meta"));
  expect(metadata).toHaveLength(2);
  for (const step of metadata) {
    expect(step.with.flavor).toBe("latest=false");
    expect(step.with.tags.trim().split("\n")).toEqual(["type=sha,format=short,prefix=sha-", "type=ref,event=tag"]);
  }
  expect(publish.outputs).toEqual({
    "sandbox-digest": "${{ steps.sandbox.outputs.digest }}",
    "kaeno-digest": "${{ steps.kaeno.outputs.digest }}",
  });
  expect(promotion.env.SANDBOX_DIGEST).toBe("${{ needs.publish.outputs.sandbox-digest }}");
  expect(promotion.env.KAENO_DIGEST).toBe("${{ needs.publish.outputs.kaeno-digest }}");
  expect(publish.steps.find((step: any) => step.id === "kaeno").with["build-args"])
    .toBe("SANDBOX_IMAGE=ghcr.io/mjrmyr/kaeno-sandbox@${{ steps.sandbox.outputs.digest }}\n");
});

it("checks live main before promoting the exact digest pair to all four aliases", async () => {
  const { result, calls, writes } = await runPromotion();
  expect(result.status).toBe(0);
  expect(calls[0]).toBe("gh api repos/mjrmyr/kaeno/git/ref/heads/main --header Cache-Control: no-cache --jq .object.sha");
  expect(writes).toEqual([
    `docker buildx imagetools create --prefer-index=false --tag ghcr.io/mjrmyr/kaeno-sandbox:main --tag ghcr.io/mjrmyr/kaeno-sandbox:latest ghcr.io/mjrmyr/kaeno-sandbox@${sandboxDigest}`,
    `docker buildx imagetools create --prefer-index=false --tag ghcr.io/mjrmyr/kaeno:main --tag ghcr.io/mjrmyr/kaeno:latest ghcr.io/mjrmyr/kaeno@${kaenoDigest}`,
  ]);
});

it("skips an old build or retry without any alias writes", async () => {
  const { result, writes } = await runPromotion({ sha: old });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Skipping aliases");
  expect(writes).toEqual([]);
});

it("fails closed if the live HEAD API fails", async () => {
  const { result, writes } = await runPromotion({ apiFailure: true });
  expect(result.status).not.toBe(0);
  expect(writes).toEqual([]);
});

it("does not promote on an empty HEAD response", async () => {
  const { result, writes } = await runPromotion({ head: "" });
  expect(result.status).toBe(0);
  expect(writes).toEqual([]);
});

it("an out-of-order old retry cannot undo a newer promotion", async () => {
  expect((await runPromotion({ sha: old, head: old })).writes).toHaveLength(2);
  expect((await runPromotion()).writes).toHaveLength(2);
  expect((await runPromotion({ sha: old })).writes).toEqual([]);
});

it("stops if sandbox promotion fails, and a current-main retry writes the whole pair", async () => {
  const failed = await runPromotion({ registryFailure: "kaeno-sandbox:main" });
  expect(failed.result.status).not.toBe(0);
  expect(failed.writes).toHaveLength(1);
  expect((await runPromotion()).writes).toHaveLength(2);
});

it("a partial pair is repaired by current-main retry, never by an old retry", async () => {
  const failed = await runPromotion({ registryFailure: "--tag ghcr.io/mjrmyr/kaeno:main" });
  expect(failed.result.status).not.toBe(0);
  expect(failed.writes).toHaveLength(2); // Sandbox succeeded; kaeno was attempted.
  expect((await runPromotion({ sha: old })).writes).toEqual([]);
  expect((await runPromotion()).writes).toHaveLength(2);
});
