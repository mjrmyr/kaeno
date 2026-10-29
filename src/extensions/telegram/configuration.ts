import { readFile } from "node:fs/promises";
import type { Transcriber } from "../transcription/index.ts";
import { TelegramClient } from "./client.ts";
import { telegramConfigurationSchema, telegramExtension } from "./telegram.ts";

/** Owner configuration and host-only token; never included in agent setup or prompts. */
export async function loadTelegram(
  env: NodeJS.ProcessEnv,
  transcriber?: Transcriber,
): Promise<ReturnType<typeof telegramExtension> | undefined> {
  const path = env.KAENO_TELEGRAM_CONFIG;
  if (!path) {
    if (env.TELEGRAM_BOT_TOKEN) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN requires KAENO_TELEGRAM_CONFIG with allowedChatIds",
      );
    }
    return undefined;
  }
  const config = telegramConfigurationSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  return telegramExtension({
    ...config,
    client: new TelegramClient(env.TELEGRAM_BOT_TOKEN ?? ""),
    transcriber,
    onError: (error) => console.error("telegram:", error),
  });
}
