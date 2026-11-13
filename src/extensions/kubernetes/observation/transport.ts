import { request } from "node:https";
import { z } from "zod";

export const originSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  );
}, "Use an HTTPS origin without credentials or path");
export class ObservationError extends Error {
  readonly category: "Forbidden" | "Unavailable" | "Invalid" | "Truncated";
  constructor(category: ObservationError["category"]) {
    super(`Kubernetes observation ${category.toLowerCase()}`);
    this.category = category;
  }
}
export interface TransportOptions {
  origin: string;
  readToken(): Promise<string>;
  ca?: string;
}
/** No response bodies or native errors cross this transport boundary. Bounded before JSON parsing. */
export async function readJson(
  options: TransportOptions,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const token = (await options.readToken()).trim();
    if (!token || /[\r\n]/.test(token)) {
      throw new ObservationError("Unavailable");
    }
    const text = await new Promise<string>((resolve, reject) => {
      const req = request(
        `${options.origin.replace(/\/$/, "")}${path}`,
        {
          method: "GET",
          ca: options.ca,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
          },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.destroy();
            reject(
              new ObservationError(
                res.statusCode === 401 || res.statusCode === 403
                  ? "Forbidden"
                  : "Unavailable",
              ),
            );
            return;
          }
          let bytes = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              res.destroy(new ObservationError("Truncated"));
            } else {
              chunks.push(chunk);
            }
          });
          res.on("error", reject);
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      req.on("error", reject);
      req.end();
    });
    try {
      return JSON.parse(text);
    } catch {
      throw new ObservationError("Invalid");
    }
  } catch (error) {
    throw error instanceof ObservationError
      ? error
      : new ObservationError("Unavailable");
  }
}
