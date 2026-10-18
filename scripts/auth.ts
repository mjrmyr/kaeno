import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  DEFAULT_AUTH_FILE,
  FileCredentialStore,
} from "../src/host/auth/index.ts";

const usage = "Usage: npm run auth -- login openai [--output <file>]";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (
    positionals.length !== 2 ||
    positionals[0] !== "login" ||
    positionals[1] !== "openai" ||
    values.output === ""
  ) {
    throw new Error(usage);
  }
  const path =
    values.output ?? process.env.KAENO_AUTH_FILE ?? DEFAULT_AUTH_FILE;
  const credentials = new FileCredentialStore(path);
  const deviceId = await credentials.getDeviceId();
  const models = createModels({ credentials });
  models.setProvider(openaiProvider());
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  terminal.on("SIGINT", cancel);
  try {
    await models.login(
      "openai",
      "oauth",
      {
        signal: cancellation.signal,
        prompt: async (prompt) => {
          if (prompt.type !== "manual_code") {
            throw new Error("Unexpected OpenAI login prompt");
          }
          return terminal.question(`${prompt.message}\n> `, {
            signal: AbortSignal.any([
              cancellation.signal,
              ...(prompt.signal ? [prompt.signal] : []),
            ]),
          });
        },
        notify: (event) => {
          switch (event.type) {
            case "auth_url":
              console.log(`Open in your browser:\n${event.url}`);
              if (event.instructions) {
                console.log(event.instructions);
              }
              break;
            case "device_code":
              console.log(
                `Open ${event.verificationUri} and enter ${event.userCode}`,
              );
              break;
            case "info":
            case "progress":
              console.log(event.message);
              break;
          }
        },
      },
      { agentName: "Kaeno", getDeviceId: () => deviceId },
    );
    console.log(`OpenAI subscription credentials saved to ${path}`);
  } catch {
    // Provider errors may contain token-response bodies. Do not print them.
    throw new Error(
      "OpenAI login failed or was cancelled. Check the browser authorization and that port 1455 is free, then retry.",
    );
  } finally {
    terminal.close();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Authentication failed",
  );
  process.exitCode = 1;
});
