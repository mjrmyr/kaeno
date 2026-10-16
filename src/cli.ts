import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openWorkspace } from "./index.ts";
import { localCoding } from "./local.ts";

const [database = "./kaeno.sqlite", key = "main"] = process.argv.slice(2);
const modelId = process.env.KAENO_MODEL ?? "gpt-4.1";
const models = createModels();
models.setProvider(openaiProvider());
const workspace = await openWorkspace({
  database,
  models,
  agent: { model: { provider: "openai", modelId } },
  extensions: process.env.KAENO_LOCAL_CODING === "1" ? [localCoding] : [],
});
const terminal = createInterface({ input: stdin, output: stdout });
try {
  const conversation = await workspace.conversation(key);
  for (;;) {
    const text = await terminal.question("> ").catch(() => "");
    if (!text.trim()) {
      break;
    }
    const result = await (
      await conversation.submit(
        { type: "input", content: text },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);
    if (result.status !== "done" || result.type !== "input") {
      console.error(
        `Unanswered: ${result.status === "unanswered" ? result.reason : "unknown"}`,
      );
      continue;
    }
    const entry = (await conversation.context(BACKGROUND_CONTEXT)).entries.find(
      (item) => item.id === result.answer,
    );
    console.log(
      entry?.model
        ?.filter((message) => message.role === "assistant")
        .flatMap((message) =>
          message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text),
        )
        .join("\n") ?? "",
    );
  }
} finally {
  terminal.close();
  await workspace.close();
}
