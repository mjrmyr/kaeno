import { expect, it, vi } from "vitest";
import {
  createTranscriber,
  transcriptionConfigurationSchema,
  voiceMessage,
  type Transcriber,
} from "./index.ts";

function multipart(init: RequestInit | undefined): FormData {
  const body = init?.body;
  if (!(body instanceof FormData)) {
    throw new Error("Expected a multipart body");
  }
  return body;
}
const openai = transcriptionConfigurationSchema.parse({
  baseUrl: "https://api.openai.com/v1/",
  model: "gpt-4o-transcribe",
  apiKeyEnv: "OPENAI_API_KEY",
});

it("posts the audio to an OpenAI-compatible endpoint with the key from the environment", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ text: " hello \n" })));
  const transcriber = createTranscriber(
    openai,
    { OPENAI_API_KEY: "sk-test" },
    fetch,
  );
  expect(
    await transcriber.transcribe(new Uint8Array([1]), "audio/webm;codecs=opus"),
  ).toBe("hello");
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect(init?.headers).toEqual({ authorization: "Bearer sk-test" });
  const form = multipart(init);
  expect(form.get("model")).toBe("gpt-4o-transcribe");
  const file = form.get("file");
  expect(file instanceof File && [file.name, file.type]).toEqual([
    "voice.webm",
    "audio/webm",
  ]);
});

it("needs no key for a local server and reports failures by status only", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response("bad key sk-leak", { status: 401 }));
  const transcriber = createTranscriber(
    transcriptionConfigurationSchema.parse({
      baseUrl: "http://localhost:8000/v1",
      model: "whisper-large-v3",
    }),
    {},
    fetch,
  );
  await expect(
    transcriber.transcribe(new Uint8Array([1]), "audio/ogg"),
  ).rejects.toThrow(/^Transcription failed: HTTP 401$/);
  expect(fetch.mock.calls[0][1]?.headers).toEqual({});
});

it("rejects keys in the file and a missing key variable", () => {
  expect(() =>
    transcriptionConfigurationSchema.parse({
      baseUrl: "https://api.openai.com/v1",
      model: "m",
      apiKey: "secret",
    }),
  ).toThrow();
  expect(() => createTranscriber(openai, {})).toThrow(
    "Transcription configuration requires OPENAI_API_KEY",
  );
});

it("frames a voice message the same way for every channel and refuses silence", async () => {
  const transcribe = vi
    .fn<Transcriber["transcribe"]>()
    .mockResolvedValueOnce("how are you")
    .mockResolvedValueOnce("");
  const audio = new Uint8Array([1]);
  expect(await voiceMessage({ transcribe }, audio, "audio/ogg")).toMatch(
    /^\[Voice message.*\]\nhow are you$/,
  );
  await expect(
    voiceMessage({ transcribe }, audio, "audio/ogg"),
  ).rejects.toThrow("No speech recognized");
});
