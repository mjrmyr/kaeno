import { z } from "zod";

/** Speech in and out for a channel. Audio stays on the host; agents only see text. */
export interface Speech {
  transcribe(audio: Uint8Array<ArrayBuffer>, mimeType: string): Promise<string>;
  synthesize(
    text: string,
  ): Promise<{ audio: Uint8Array<ArrayBuffer>; mimeType: string }>;
}

// Secrets stay in the environment: the configuration names the variable, never the key.
const apiKeyEnv = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const baseUrl = z
  .url({ protocol: /^https?$/ })
  .transform((value) => value.replace(/\/+$/, ""));
export const speechConfigurationSchema = z
  .object({
    /** Any OpenAI-compatible `/audio/transcriptions` endpoint: OpenAI, Groq, a local whisper server. */
    transcription: z
      .object({
        baseUrl,
        model: z.string().min(1),
        apiKeyEnv: apiKeyEnv.optional(),
      })
      .strict(),
    synthesis: z.discriminatedUnion("provider", [
      z
        .object({
          provider: z.literal("elevenlabs"),
          model: z.string().min(1),
          voice: z.string().min(1),
          apiKeyEnv,
        })
        .strict(),
      /** Any OpenAI-compatible `/audio/speech` endpoint, such as a local Kokoro server. */
      z
        .object({
          provider: z.literal("openai-compatible"),
          baseUrl,
          model: z.string().min(1),
          voice: z.string().min(1),
          instructions: z.string().min(1).optional(),
          apiKeyEnv: apiKeyEnv.optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export type SpeechConfiguration = z.infer<typeof speechConfigurationSchema>;

function secret(name: string | undefined, env: NodeJS.ProcessEnv) {
  if (!name) {
    return undefined;
  }
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Speech configuration requires ${name}`);
  }
  return value;
}

export function createSpeech(
  config: SpeechConfiguration,
  env: NodeJS.ProcessEnv = process.env,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Speech {
  const transcriptionKey = secret(config.transcription.apiKeyEnv, env);
  const synthesis = config.synthesis;
  const synthesisKey = secret(synthesis.apiKeyEnv, env);
  async function request(what: string, url: string, init: RequestInit) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      // Provider bodies can echo request details; the status is enough to act on.
      throw new Error(`Speech ${what} failed: HTTP ${response.status}`);
    }
    return response;
  }
  return {
    async transcribe(audio, mimeType) {
      const form = new FormData();
      form.set("model", config.transcription.model);
      form.set("file", new Blob([audio], { type: mimeType }), "voice.ogg");
      const response = await request(
        "transcription",
        `${config.transcription.baseUrl}/audio/transcriptions`,
        {
          method: "POST",
          headers: transcriptionKey
            ? { authorization: `Bearer ${transcriptionKey}` }
            : {},
          body: form,
        },
      );
      return z
        .object({ text: z.string() })
        .parse(await response.json())
        .text.trim();
    },
    async synthesize(text) {
      const response =
        synthesis.provider === "elevenlabs"
          ? await request(
              "synthesis",
              `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(synthesis.voice)}?output_format=mp3_44100_128`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "xi-api-key": synthesisKey ?? "",
                },
                body: JSON.stringify({ text, model_id: synthesis.model }),
              },
            )
          : await request("synthesis", `${synthesis.baseUrl}/audio/speech`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(synthesisKey
                  ? { authorization: `Bearer ${synthesisKey}` }
                  : {}),
              },
              body: JSON.stringify({
                model: synthesis.model,
                voice: synthesis.voice,
                input: text,
                instructions: synthesis.instructions,
                response_format: "mp3",
              }),
            });
      return {
        audio: new Uint8Array(await response.arrayBuffer()),
        mimeType: "audio/mpeg",
      };
    },
  };
}
