import { readFile } from "node:fs/promises";
import { z } from "zod";

export interface Transcriber {
  transcribe(audio: Uint8Array<ArrayBuffer>, mimeType: string): Promise<string>;
}

export const transcriptionConfigurationSchema = z
  .object({
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .transform((value) => value.replace(/\/+$/, "")),
    model: z.string().min(1),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .optional(),
  })
  .strict();
export type TranscriptionConfiguration = z.infer<
  typeof transcriptionConfigurationSchema
>;

const extensions: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

export function createTranscriber(
  config: TranscriptionConfiguration,
  env: NodeJS.ProcessEnv = process.env,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Transcriber {
  const key = config.apiKeyEnv ? env[config.apiKeyEnv]?.trim() : undefined;
  if (config.apiKeyEnv && !key) {
    throw new Error(`Transcription configuration requires ${config.apiKeyEnv}`);
  }
  return {
    async transcribe(audio, mimeType) {
      const type = mimeType.split(";")[0].trim();
      const form = new FormData();
      form.set("model", config.model);
      form.set(
        "file",
        new Blob([audio], { type }),
        `voice.${extensions[type] ?? "ogg"}`,
      );
      const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: key ? { authorization: `Bearer ${key}` } : {},
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        throw new Error(`Transcription failed: HTTP ${response.status}`);
      }
      return z
        .object({ text: z.string() })
        .parse(await response.json())
        .text.trim();
    },
  };
}

export async function loadTranscription(path: string): Promise<Transcriber> {
  return createTranscriber(
    transcriptionConfigurationSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    ),
  );
}

export async function voiceMessage(
  transcriber: Transcriber,
  audio: Uint8Array<ArrayBuffer>,
  mimeType: string,
): Promise<string> {
  const transcript = await transcriber.transcribe(audio, mimeType);
  if (!transcript) {
    throw new Error("No speech recognized in that voice message");
  }
  return `[Voice message, transcribed; it may contain recognition errors]\n${transcript}`;
}
