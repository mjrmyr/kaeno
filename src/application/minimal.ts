import { configure } from "@earendil-works/pi-durable";
import type { Config } from "../config/index.ts";
import type { ChatAgent } from "../threads/index.ts";

/** Native chat binding with no WORK, sandbox, tools, or skill-cache dependencies. */
export function minimalChatAgent(config: Config): ChatAgent {
  const template = config.templates[config.agent];
  return {
    async configureChatConversation(tx, id) {
      await configure(tx, id, {
        model: template.model,
        thinkingLevel: template.thinkingLevel ?? null,
        instructions: template.instructions,
        extensions: [],
        tools: [],
        cwd: null,
      });
    },
  };
}
