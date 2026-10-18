import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { z } from "zod";

export const DEFAULT_AUTH_FILE = join(homedir(), ".kaeno/auth.json");

const credentialSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("oauth"),
      access: z.string().min(1),
      refresh: z.string().min(1),
      expires: z.number().finite(),
    })
    .passthrough(),
  z.object({
    type: z.literal("api_key"),
    key: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
]);
const documentSchema = z.object({
  deviceId: z.uuid(),
  credentials: z.record(z.string(), credentialSchema),
});
type AuthDocument = z.infer<typeof documentSchema>;

/** Server-only storage. Never mount this file in an agent execution environment. */
export class FileCredentialStore implements CredentialStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  private async load(
    options?: AuthOperationOptions,
  ): Promise<AuthDocument | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, {
        encoding: "utf8",
        signal: options?.signal,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
    // Do not include credential values in validation errors.
    try {
      return documentSchema.parse(JSON.parse(text));
    } catch {
      throw new Error(`Invalid credential file: ${this.path}`);
    }
  }

  private async update(
    change: (document: AuthDocument) => Promise<void>,
    options?: AuthOperationOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Lock the whole document, including across processes, before refreshing a rotated token.
    const release = await lock(this.path, {
      realpath: false,
      retries: { retries: 50, minTimeout: 20, maxTimeout: 200 },
    });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      options?.signal?.throwIfAborted();
      const existing = await this.load(options);
      const before = JSON.stringify(existing);
      const document = existing ?? { deviceId: randomUUID(), credentials: {} };
      await change(document);
      const after = JSON.stringify(document);
      if (after === before) {
        return;
      }
      await writeFile(temporary, `${after}\n`, {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
      await rename(temporary, this.path);
    } finally {
      try {
        await rm(temporary, { force: true });
      } finally {
        await release();
      }
    }
  }

  async getDeviceId(): Promise<string> {
    let deviceId = "";
    await this.update(async (document) => {
      deviceId = document.deviceId;
    });
    return deviceId;
  }

  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return (await this.load(options))?.credentials[providerId];
  }

  async list(
    options?: AuthOperationOptions,
  ): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries((await this.load(options))?.credentials ?? {}).map(
      ([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }),
    );
  }

  async modify(
    providerId: string,
    change: (
      current: Credential | undefined,
    ) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    let credential: Credential | undefined;
    await this.update(async (document) => {
      credential = await change(document.credentials[providerId]);
      if (credential) {
        document.credentials[providerId] = credential;
      }
      credential = document.credentials[providerId];
    }, options);
    return credential;
  }

  async delete(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<void> {
    await this.update(async (document) => {
      delete document.credentials[providerId];
    }, options);
  }
}
