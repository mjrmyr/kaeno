import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
it("release images do not bundle agent configuration or skills", async () => {
  const dockerfile = await readFile(
    new URL("../../Dockerfile", import.meta.url),
    "utf8",
  );
  const ignore = await readFile(
    new URL("../../.dockerignore", import.meta.url),
    "utf8",
  );
  expect(dockerfile).not.toMatch(
    /COPY.*(?:skill-bundle|config\.json)|RUN.*(?:skills@|prepareSkills)/,
  );
  expect(ignore.split("\n")).toContain("skill-bundle");
  expect(ignore.split("\n")).toContain("config.snapshot.json");
});
