/**
 * The one reference rule for qualified ids (`<namespace>:<name>`, e.g. `local:swe` or `owner/repo:swe`):
 * the exact id, otherwise every id whose name part equals the reference. Callers decide how to report
 * zero or several matches.
 */
export function qualifiedIdMatches(
  reference: string,
  ids: Iterable<string>,
): string[] {
  const candidates = [...ids];
  if (candidates.includes(reference)) {
    return [reference];
  }
  return candidates.filter((id) => id.endsWith(`:${reference}`));
}
