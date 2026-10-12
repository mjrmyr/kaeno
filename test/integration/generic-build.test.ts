import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
it("release builds have no skill/config input; runtime cache and legacy bundles cannot enter the context", async () => {
  const dockerfile = await readFile(
    new URL("../../Dockerfile", import.meta.url),
    "utf8",
  );
  const deploy = await readFile(
    new URL("../../scripts/deploy.sh", import.meta.url),
    "utf8",
  );
  const ignore = await readFile(
    new URL("../../.dockerignore", import.meta.url),
    "utf8",
  );
  expect(deploy).not.toMatch(
    /build-skills|prepareSkills|apps\/kaeno\/config\.json|config\.snapshot|skillRepositories/,
  );
  expect(dockerfile).not.toMatch(
    /COPY.*(?:skill-bundle|config\.json)|RUN.*(?:skills@|prepareSkills)/,
  );
  expect(ignore.split("\n")).toContain("skill-bundle");
  expect(ignore.split("\n")).toContain("config.snapshot.json");
});
