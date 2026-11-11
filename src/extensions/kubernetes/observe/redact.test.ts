import { expect, it } from "vitest";
import { redact } from "../index.ts";

it.each([
  ["password=hunter2 user=bob", "password=[REDACTED] user=bob"],
  ["DB_PASSWORD: s3cr3t", "DB_PASSWORD: [REDACTED]"],
  ['{"apiKey":"abc123","n":1}', '{"apiKey":"[REDACTED]","n":1}'],
  ["--token=abcdef running", "--token=[REDACTED] running"],
  [
    "Authorization: Bearer abcdefghijklmnop",
    "Authorization: [REDACTED] [REDACTED]",
  ],
  ["got bearer abcdefghijklmnop", "got bearer [REDACTED]"],
  [
    "connect postgres://app:pa55word@db:5432/app",
    "connect postgres://app:[REDACTED]@db:5432/app",
  ],
  ["key AKIAABCDEFGHIJKLMNOP", "key [REDACTED]"],
  ["ghp_abcdefghijklmnopqrstuvwxyz0123", "[REDACTED]"],
  [
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz",
    "jwt [REDACTED]",
  ],
  [
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\nnext",
    "[REDACTED]\nnext",
  ],
])("masks %j", (input, output) => {
  expect(redact(input)).toBe(output);
});

it("leaves ordinary log lines alone", () => {
  const lines = [
    "2026-11-11T10:00:00Z INFO GET /healthz 200 3ms",
    "commit 0123456789abcdef0123456789abcdef01234567 deployed",
    "request 550e8400-e29b-41d4-a716-446655440000 failed: connection refused",
    "Back-off restarting failed container app in pod web-5d8f",
    "listening on http://0.0.0.0:8080",
  ];
  for (const line of lines) {
    expect(redact(line)).toBe(line);
  }
});
