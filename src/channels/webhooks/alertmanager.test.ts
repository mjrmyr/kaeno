import { expect, it } from "vitest";
import { alertmanagerAdapter, WebhookUnauthorized } from "./index.ts";

const SECRET = "alertmanager-secret-with-32-chars!";
const firing = {
  version: "4",
  groupKey: '{}:{alertname="KubePodCrashLooping"}',
  status: "firing",
  receiver: "kaeno",
  truncatedAlerts: 0,
  alerts: [
    {
      status: "firing",
      labels: {
        alertname: "KubePodCrashLooping",
        severity: "warning",
        namespace: "apps",
        pod: "worker",
      },
      annotations: {
        summary: "Pod is crash looping.",
        description: "apps/worker restarted 12 times.",
        runbook_url: "https://runbooks/x",
      },
      startsAt: "2026-11-11T10:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "http://prometheus/graph",
      fingerprint: "a1b2",
    },
  ],
};

function read(payload: object, authorization = `Bearer ${SECRET}`) {
  return alertmanagerAdapter(SECRET).read(
    { authorization },
    Buffer.from(JSON.stringify(payload)),
  );
}

it("rejects requests without the bearer secret", () => {
  expect(() => read(firing, "Bearer wrong")).toThrow(WebhookUnauthorized);
  expect(() => read(firing, "")).toThrow(WebhookUnauthorized);
});

it("describes a firing group on its own thread", () => {
  const event = read(firing);
  expect(event).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{32}$/),
    threads: [expect.stringMatching(/^[0-9a-f]{16}$/)],
    actor: "alertmanager",
    text: [
      "Alertmanager: 1 alert(s) firing.",
      "- [firing] KubePodCrashLooping severity=warning namespace=apps pod=worker",
      "  since 2026-11-11T10:00:00Z",
      "  summary: Pod is crash looping.",
      "  description: apps/worker restarted 12 times.",
    ].join("\n"),
    closes: false,
  });
  expect(read(firing)?.id).toBe(event?.id);
});

it("closes the group's thread when it resolves", () => {
  const resolved = read({
    ...firing,
    status: "resolved",
    alerts: firing.alerts.map((alert) => ({
      ...alert,
      status: "resolved",
      endsAt: "2026-11-11T10:30:00Z",
    })),
  });
  const event = read(firing);
  expect(resolved?.threads).toEqual(event?.threads);
  expect(resolved?.id).not.toBe(event?.id);
  expect(resolved?.closes).toBe(true);
  expect(resolved?.text).toContain("all alerts resolved");
  expect(resolved?.text).toContain("resolved 2026-11-11T10:30:00Z");
});
