import { readFile } from "node:fs/promises";
import { createSpeech } from "../speech/index.ts";
import { TelegramClient } from "./client.ts";
import { telegramConfigurationSchema, telegramExtension } from "./telegram.ts";

/** Owner configuration and host-only token; never included in agent setup or prompts. */
export async function loadTelegramConfiguration(
  path: string,
  token: string,
): Promise<ReturnType<typeof telegramExtension>> {
  const config = telegramConfigurationSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  return telegramExtension({
    allowedChatIds: config.allowedChatIds,
    client: new TelegramClient(token),
    speech: config.speech && createSpeech(config.speech),
    onError: (error) => console.error("telegram:", error),
  });
}
