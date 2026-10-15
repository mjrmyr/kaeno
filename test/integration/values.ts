import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { Server } from "node:http";
import { z } from "zod";
import type { SandboxResources } from "../../src/sandboxes/index.ts";
import { readBlueprint, type WorkBlueprint } from "../../src/work/index.ts";
/** Sandbox size for fixtures. Tests size the pool themselves via setSandboxQuota. */
export const SANDBOX_RESOURCES: SandboxResources = {
  requests: { cpu: "250m", memory: "256Mi" },
  limits: { cpu: "2", memory: "2Gi" },
};
export function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error("Expected fixture value");
  }
  return value;
}
export function serverPort(server: Server): number {
  return z.object({ port: z.number() }).parse(server.address()).port;
}
export function messageText(
  message: TranscriptContext["messages"][number],
): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .map((block) => ("text" in block ? block.text : ""))
    .join("");
}
export function readObject(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}
export function storedBlueprint(value: unknown): WorkBlueprint {
  return readBlueprint(
    z.object({ blueprint: z.unknown() }).parse(value).blueprint,
  );
}
export interface ReplyPage {
  replies: {
    text: string;
  }[];
  next: number;
}
export function replyPage(value: unknown): ReplyPage {
  return z
    .object({
      replies: z.array(z.object({ text: z.string() })),
      next: z.number(),
    })
    .parse(value);
}
