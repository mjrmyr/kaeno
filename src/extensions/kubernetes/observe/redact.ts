const MASK = "[REDACTED]";

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, MASK],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, MASK],
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${MASK}@`],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [
    /\b(?:gh[pousr]_\w{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|sk-[\w-]{20,})/g,
    MASK,
  ],
];
const SECRET_VALUE =
  /([\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization|cookie)[\w.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}\]]+)/gi;

export function redact(text: string): string {
  return PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  ).replace(SECRET_VALUE, (_, key: string, value: string) => {
    const quote = /^["']/.test(value) ? value[0] : "";
    return `${key}${quote}${MASK}${quote}`;
  });
}
