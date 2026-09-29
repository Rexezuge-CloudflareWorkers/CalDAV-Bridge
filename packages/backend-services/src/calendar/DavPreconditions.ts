/**
 * ETag identity and the conditional-header evaluation built on it.
 *
 * The comparison functions differ only in whether a `W/` prefix is significant,
 * which is easy to get wrong in a single shared helper, so the two are separate
 * and named rather than selected by a boolean at each call site.
 */

/** The current representation of an event, as an ETag. */
function eventEtag(event: { etag?: string | undefined; updated?: string | undefined; uid: string }): string {
  return quoteEtag(event.etag || event.updated || event.uid);
}

/** Quote a value as an entity tag, leaving an already-quoted one alone. */
function quoteEtag(value: string): string {
  const trimmed = value.trim();
  if (/^(?:W\/)?".*"$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** ETag identity for strong comparison: the `W/` prefix is significant. */
function strongEtag(value: string): string {
  return quoteEtag(value.trim());
}

/** ETag identity for weak comparison: `W/` is not significant. */
function weakEtag(value: string): string {
  return quoteEtag(value.replace(/^W\//, '').trim());
}

/**
 * Split a comma-separated ETag list.
 *
 * `split(',')` is wrong: an entity tag may contain a comma (`W/"a,b"`), so a
 * naive split yields fragments that match nothing. Each element is either a
 * quoted string or `*`, and the quote is what delimits it.
 */
function parseEtagList(condition: string): string[] {
  return (condition.match(/(?:W\/)?"(?:[^"\\]|\\.)*"|\*/g) ?? []).map((item) => item.trim()).filter(Boolean);
}

/**
 * Evaluate `If-Match` against the current ETag, using strong comparison.
 *
 * RFC 7232 §3.1 requires the strong function here: `W/"x"` does not match a
 * resource whose ETag is `"x"`, because weak comparison is only appropriate
 * where byte-identity is not required -- which is not the case for a
 * precondition guarding a write.
 */
function ifMatchMatches(condition: string | null, currentEtag?: string | undefined): boolean {
  return matches(condition, currentEtag, strongEtag);
}

/**
 * Evaluate `If-None-Match`, using weak comparison.
 *
 * Absent means the condition is not being made, which is a success rather than
 * a failure -- a client sending no precondition is asking for an unconditional
 * write.
 */
function ifNoneMatchMatches(condition: string | null, currentEtag?: string | undefined): boolean {
  return matches(condition, currentEtag, weakEtag);
}

function matches(condition: string | null, currentEtag: string | undefined, normalize: (value: string) => string): boolean {
  if (!condition) return true;
  const trimmed = condition.trim();
  if (trimmed === '*') return Boolean(currentEtag);
  if (!currentEtag) return false;
  return parseEtagList(trimmed).some((candidate) => normalize(candidate) === normalize(currentEtag));
}

export { eventEtag, ifMatchMatches, ifNoneMatchMatches, quoteEtag };
