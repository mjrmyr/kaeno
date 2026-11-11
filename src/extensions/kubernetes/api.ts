import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

export interface ApiOptions {
  api: string;
  readToken(): Promise<string>;
  ca?: string;
  fetch?: typeof globalThis.fetch;
}

/** Token is read for every request so projected service-account rotation is respected. */
export async function apiRequest(
  options: ApiOptions,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  const token = (await options.readToken()).trim();
  const url = `${options.api}${path}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const textBody = body === undefined ? undefined : JSON.stringify(body);
  if (options.fetch) {
    const response = await options.fetch(url, {
      method,
      headers,
      body: textBody,
      signal: requestSignal,
    });
    return { status: response.status, text: await response.text() };
  }
  // Native HTTPS supports a cluster's private CA without disabling certificate verification.
  return new Promise((resolve, reject) => {
    const transport =
      new URL(url).protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(
      url,
      { method, headers, ca: options.ca, signal: requestSignal },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            response.destroy(new Error("Kubernetes response exceeds 4 MiB"));
          } else {
            chunks.push(chunk);
          }
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 500,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(textBody);
  });
}
