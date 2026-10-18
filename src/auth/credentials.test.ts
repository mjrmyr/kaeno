import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "./index.ts";

const directories: string[] = [];
async function authPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-auth-"));
  directories.push(directory);
  return join(directory, "auth.json");
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("persists credentials, provider metadata, and a stable installation ID with private permissions", async () => {
  const path = await authPath();
  const store = new FileCredentialStore(path);
  expect(await store.read("openai")).toBeUndefined();
  const deviceId = await store.getDeviceId();
  const credential = {
    type: "oauth",
    access: "access-secret",
    refresh: "refresh-secret",
    expires: 123,
    clientId: "issued-client",
  } as const;
  await store.modify("openai", async () => credential);
  const restarted = new FileCredentialStore(path);
  expect(await restarted.getDeviceId()).toBe(deviceId);
  expect(await restarted.read("openai")).toEqual(credential);
  expect(await restarted.list()).toEqual([
    { providerId: "openai", type: "oauth" },
  ]);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await restarted.delete("openai");
  expect(await store.read("openai")).toBeUndefined();
  expect(await restarted.getDeviceId()).toBe(deviceId);
});

it("serializes read-modify-write across independent stores and keeps other providers", async () => {
  const path = await authPath();
  const first = new FileCredentialStore(path);
  const second = new FileCredentialStore(path);
  await first.modify("openai", async () => ({
    type: "oauth",
    access: "old",
    refresh: "refresh",
    expires: 0,
  }));
  await Promise.all([
    first.modify("openai", async (credential) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(credential?.type).toBe("oauth");
      if (credential?.type !== "oauth") {
        throw new Error("Expected OAuth");
      }
      return { ...credential, access: `${credential.access}-first` };
    }),
    second.modify("openai", async (credential) => {
      if (credential?.type !== "oauth") {
        throw new Error("Expected OAuth");
      }
      return { ...credential, access: `${credential.access}-second` };
    }),
    second.modify("other", async () => ({
      type: "api_key",
      key: "other-secret",
    })),
  ]);
  const credential = await first.read("openai");
  expect(credential?.type === "oauth" && credential.access).toMatch(
    /^old-(first-second|second-first)$/,
  );
  expect(await first.read("other")).toEqual({
    type: "api_key",
    key: "other-secret",
  });
});

it("leaves the file untouched after unchanged or failed updates and releases its lock", async () => {
  const path = await authPath();
  const store = new FileCredentialStore(path);
  await store.getDeviceId();
  const original = await readFile(path, "utf8");
  await store.modify("openai", async () => undefined);
  expect(await readFile(path, "utf8")).toBe(original);
  await expect(
    store.modify("openai", async () => {
      throw new Error("refresh failed");
    }),
  ).rejects.toThrow("refresh failed");
  expect(await readFile(path, "utf8")).toBe(original);
  await store.modify("openai", async () => ({ type: "api_key", key: "new" }));
  expect(await readdir(join(path, ".."))).toEqual(["auth.json"]);
});

it("rejects corrupt credentials without leaking their content or overwriting them", async () => {
  const path = await authPath();
  const content = JSON.stringify({
    deviceId: "secret-invalid-id",
    credentials: {},
  });
  await writeFile(path, content);
  const store = new FileCredentialStore(path);
  await expect(store.read("openai")).rejects.toThrow(
    `Invalid credential file: ${path}`,
  );
  await expect(store.getDeviceId()).rejects.toThrow(
    `Invalid credential file: ${path}`,
  );
  expect(await readFile(path, "utf8")).toBe(content);
});

it("does not mutate storage for an already cancelled operation", async () => {
  const path = await authPath();
  const store = new FileCredentialStore(path);
  const options = { signal: AbortSignal.abort() };
  await expect(
    store.modify(
      "openai",
      async () => ({ type: "api_key", key: "no" }),
      options,
    ),
  ).rejects.toThrow();
  await expect(store.read("openai", options)).rejects.toThrow();
  expect(await readdir(join(path, ".."))).toEqual([]);
});
