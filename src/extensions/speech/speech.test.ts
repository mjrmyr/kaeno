import { expect, it, vi } from "vitest";
import { createSpeech, speechConfigurationSchema } from "./index.ts";

const transcription = {
  baseUrl: "https://api.openai.com/v1/",
  model: "gpt-4o-transcribe",
  apiKeyEnv: "OPENAI_API_KEY",
};
function json(value: unknown) {
  return new Response(JSON.stringify(value));
}

function multipart(init: RequestInit | undefined): FormData {
  const body = init?.body;
  if (!(body instanceof FormData)) {
    throw new Error("Expected a multipart body");
  }
  return body;
}
it("transcribes through an OpenAI-compatible endpoint with the key from the environment", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(json({ text: " hello \n" }));
  const speech = createSpeech(
    speechConfigurationSchema.parse({
      transcription,
      synthesis: {
        provider: "openai-compatible",
        baseUrl: "http://localhost:8880/v1",
        model: "kokoro",
        voice: "af_heart",
      },
    }),
    { OPENAI_API_KEY: "sk-test" },
    fetch,
  );
  expect(await speech.transcribe(new Uint8Array([1]), "audio/ogg")).toBe(
    "hello",
  );
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect(init?.headers).toEqual({ authorization: "Bearer sk-test" });
  const form = multipart(init);
  expect(form.get("model")).toBe("gpt-4o-transcribe");
  const audio = form.get("file");
  expect(audio instanceof Blob && audio.type).toBe("audio/ogg");

  fetch.mockResolvedValueOnce(new Response(new Uint8Array([4, 5])));
  expect(await speech.synthesize("hi")).toEqual({
    audio: new Uint8Array([4, 5]),
    mimeType: "audio/mpeg",
  });
  const [speechUrl, speechInit] = fetch.mock.calls[1];
  expect(speechUrl).toBe("http://localhost:8880/v1/audio/speech");
  // A local server needs no key.
  expect(speechInit?.headers).toEqual({ "content-type": "application/json" });
  expect(JSON.parse(String(speechInit?.body))).toEqual({
    model: "kokoro",
    voice: "af_heart",
    input: "hi",
    response_format: "mp3",
  });
});

it("synthesizes with ElevenLabs and reports failures by status only", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(new Uint8Array([1])))
    .mockResolvedValueOnce(
      new Response("quota exceeded for key xi-secret", { status: 401 }),
    );
  const speech = createSpeech(
    speechConfigurationSchema.parse({
      transcription,
      synthesis: {
        provider: "elevenlabs",
        model: "eleven_v3",
        voice: "voice/id",
        apiKeyEnv: "ELEVENLABS_API_KEY",
      },
    }),
    { OPENAI_API_KEY: "sk-test", ELEVENLABS_API_KEY: "xi-secret" },
    fetch,
  );
  await speech.synthesize("hello");
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe(
    "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid?output_format=mp3_44100_128",
  );
  expect(init?.headers).toMatchObject({ "xi-api-key": "xi-secret" });
  expect(JSON.parse(String(init?.body))).toEqual({
    text: "hello",
    model_id: "eleven_v3",
  });
  await expect(speech.synthesize("hello")).rejects.toThrow(
    /^Speech synthesis failed: HTTP 401$/,
  );
});

it("rejects keys in the file, unknown providers and a missing key variable", () => {
  for (const synthesis of [
    { provider: "elevenlabs", model: "m", voice: "v", apiKey: "secret" },
    { provider: "other", model: "m", voice: "v" },
    { provider: "elevenlabs", model: "m", voice: "v", apiKeyEnv: "lower" },
  ]) {
    expect(() =>
      speechConfigurationSchema.parse({ transcription, synthesis }),
    ).toThrow();
  }
  expect(() =>
    createSpeech(
      speechConfigurationSchema.parse({
        transcription,
        synthesis: {
          provider: "elevenlabs",
          model: "m",
          voice: "v",
          apiKeyEnv: "ELEVENLABS_API_KEY",
        },
      }),
      { OPENAI_API_KEY: "sk-test" },
    ),
  ).toThrow("Speech configuration requires ELEVENLABS_API_KEY");
});
