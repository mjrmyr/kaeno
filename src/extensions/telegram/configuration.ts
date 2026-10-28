import { readFile } from "node:fs/promises";
import type { Transcriber } from "../transcription/index.ts";
import { TelegramClient } from "./client.ts";
import { telegramConfigurationSchema, telegramExtension } from "./telegram.ts";

/** Owner configuration and host-only token; never included in agent setup or prompts. */
export async function loadTelegramConfiguration(
  path: string,
  token: string,
  transcriber?: Transcriber,
): Promise<ReturnType<typeof telegramExtension>> {
  const config = telegramConfigurationSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  return telegramExtension({
    ...config,
    client: new TelegramClient(token),
    transcriber,
    onError: (error) => console.error("telegram:", error),
  });
}
