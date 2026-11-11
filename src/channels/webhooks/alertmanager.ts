import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WebhookUnauthorized, type WebhookAdapter } from "./webhooks.ts";

export const ALERTMANAGER = "alertmanager";
const MAX_ALERTS = 20;
const MAX_TEXT = 16000;

const strings = z.record(z.string(), z.string());
const notification = z.object({
  groupKey: z.string().min(1),
  status: z.enum(["firing", "resolved"]),
  truncatedAlerts: z.number().int().nonnegative().default(0),
  alerts: z.array(
    z.object({
      status: z.enum(["firing", "resolved"]),
      labels: strings,
      annotations: strings.default({}),
      startsAt: z.string(),
      endsAt: z.string().optional(),
      fingerprint: z.string().default(""),
    }),
  ),
});

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function bearer(header: unknown, secret: string): boolean {
  if (typeof header !== "string") {
    return false;
  }
  const given = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function alertmanagerAdapter(secret: string): WebhookAdapter {
  return {
    read(headers, body) {
      if (!bearer(headers.authorization, secret)) {
        throw new WebhookUnauthorized("Invalid authorization");
      }
      const group = notification.parse(JSON.parse(body.toString("utf8")));
      const alerts = group.alerts.map((alert) => {
        const { alertname = "alert", ...labels } = alert.labels;
        return [
          `- [${alert.status}] ${alertname} ${Object.entries(labels)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")}`,
          `  since ${alert.startsAt}${alert.status === "resolved" && alert.endsAt ? `, resolved ${alert.endsAt}` : ""}`,
          ...["summary", "description"].flatMap((name) =>
            alert.annotations[name]
              ? [`  ${name}: ${alert.annotations[name]}`]
              : [],
          ),
        ].join("\n");
      });
      const omitted =
        Math.max(0, alerts.length - MAX_ALERTS) + group.truncatedAlerts;
      const text = [
        `Alertmanager: ${group.status === "firing" ? `${group.alerts.filter((alert) => alert.status === "firing").length} alert(s) firing` : "all alerts resolved"}.`,
        ...alerts.slice(0, MAX_ALERTS),
        ...(omitted > 0 ? [`(${omitted} more alert(s) not shown)`] : []),
      ].join("\n");
      return {
        id: digest(
          JSON.stringify([
            group.groupKey,
            group.status,
            group.alerts
              .map((alert) =>
                [alert.fingerprint, alert.status, alert.startsAt].join(":"),
              )
              .sort(),
          ]),
        ).slice(0, 32),
        threads: [digest(group.groupKey).slice(0, 16)],
        actor: ALERTMANAGER,
        text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
        closes: group.status === "resolved",
      };
    },
  };
}
