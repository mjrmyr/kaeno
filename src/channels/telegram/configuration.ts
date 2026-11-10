import { readFile } from "node:fs/promises";
import { TelegramClient } from "./client.ts";
import { telegramConfigurationSchema, telegramChannel } from "./telegram.ts";

/** Owner configuration and host-only token; never included in agent setup or prompts. */
export async function loadTelegram(
  env: NodeJS.ProcessEnv,
): Promise<ReturnType<typeof telegramChannel> | undefined> {
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
  return telegramChannel({
    ...config,
    client: new TelegramClient(env.TELEGRAM_BOT_TOKEN ?? ""),
    onError: (error) => console.error("telegram:", error),
  });
}
