import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { RemoteExecutionEnv } from "./index.ts";
function response(frame: object): Response {
  return new Response(JSON.stringify(frame) + "\n", { status: 200 });
}
it("uses the injected transport and validates a successful text response", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response({ ret: { ok: true, value: "contents" } }));
  const env = new RemoteExecutionEnv(
    "http://sandbox",
    "secret",
    "pod-id",
    "/saved",
    transport,
  );
  expect(await env.readTextFile("/file", BACKGROUND_CONTEXT)).toEqual({
    ok: true,
    value: "contents",
  });
  const request = transport.mock.calls[0];
  expect(request[0]).toBe("http://sandbox/call");
  expect(request[1]?.headers).toMatchObject({ authorization: "Bearer secret" });
  const raw: unknown = JSON.parse(z.string().parse(request[1]?.body));
  expect(raw).toMatchObject({
    method: "readTextFile",
    args: ["/file"],
    cwd: "/saved",
  });
});
it("rejects a response of the wrong SDK result type at the network boundary", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response({ ret: { ok: true, value: 42 } }));
  const env = new RemoteExecutionEnv(
    "http://sandbox",
    "secret",
    "pod-id",
    "/saved",
    transport,
  );
  await expect(env.readTextFile("/file", BACKGROUND_CONTEXT)).rejects.toThrow();
});
it("propagates transport failures rather than inventing a successful result", async () => {
  const failure = new Error("network down");
  const transport = vi.fn<typeof fetch>().mockRejectedValue(failure);
  const env = new RemoteExecutionEnv(
    "http://sandbox",
    "secret",
    "pod-id",
    "/saved",
    transport,
  );
  await expect(env.exists("/file", BACKGROUND_CONTEXT)).rejects.toBe(failure);
});
it("rejects malformed frames and remote operation errors", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ unexpected: true }))
    .mockResolvedValueOnce(response({ err: { $err: "remote failure" } }));
  const env = new RemoteExecutionEnv(
    "http://sandbox",
    "secret",
    "pod-id",
    "/saved",
    transport,
  );
  await expect(env.exists("/file", BACKGROUND_CONTEXT)).rejects.toThrow(
    /Invalid remote response/,
  );
  await expect(env.exists("/file", BACKGROUND_CONTEXT)).rejects.toThrow(
    /remote failure/,
  );
});
