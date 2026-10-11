type Level = "debug" | "info" | "warn" | "error";
type Context = Readonly<Record<string, string | number | boolean | null>>;

// Only caller-selected safe facts: no prompts, user bodies, config/env values,
// tokens, URLs or error text. Scalar projection is not content redaction.
export function log(level: Level, component: string, event: string, context?: Context, error?: unknown): void {
  if (level === "debug") return; // Fixed info threshold; no environment configuration.
  try {
    const safeContext: Record<string, string | number | boolean | null> = Object.create(null);
    try {
      if (context !== null && typeof context === "object" && !Array.isArray(context)) {
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(context))) {
          if (!descriptor.enumerable || !("value" in descriptor)) continue;
          const value: unknown = descriptor.value;
          if (value === null || typeof value === "string" || typeof value === "boolean" ||
              (typeof value === "number" && Number.isFinite(value))) safeContext[key] = value;
        }
      }
    } catch { /* Malformed context (including revoked proxies) contributes no facts. */ }

    let kind = "unknown";
    if (error !== undefined) {
      try {
        // Never read name, message, stack, code, cause or other error properties.
        for (const [type, name] of [
          [TypeError, "TypeError"], [RangeError, "RangeError"], [ReferenceError, "ReferenceError"],
          [SyntaxError, "SyntaxError"], [URIError, "URIError"], [EvalError, "EvalError"],
          [AggregateError, "AggregateError"], [Error, "Error"],
        ] as const) {
          if (error instanceof type) { kind = name; break; }
        }
      } catch { /* Malformed unknown errors remain unknown. */ }
    }
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(), level, component, event,
      ...(Object.keys(safeContext).length ? { context: safeContext } : {}),
      ...(error !== undefined ? { error: { kind } } : {}),
    }));
  } catch { /* Logging must not change application behavior, even if output fails synchronously. */ }
}
