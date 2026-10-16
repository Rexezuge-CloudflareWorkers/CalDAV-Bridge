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
 *
 * The list is scanned rather than matched, because the header is attacker-
 * shaped input evaluated exactly at a conditional write: as a pattern, the
 * quote/escape grammar made an unterminated tag (`"` followed by `\"` repeats)
 * cost quadratic backtracking. A backslash escapes the next character -- the
 * pattern treated one before a line terminator as ordinary text instead, which
 * only matters for characters a header value cannot carry (raw CR/LF) or for
 * the caller's own precondition (the exotic separators). Once an opening quote
 * has no unescaped closing quote, no later quoted token can close either, so
 * only bare `*` tokens remain to be found and the scan stays linear. A `W/`
 * prefix is part of the tag so the strong and weak comparisons can still tell
 * it apart.
 */
function parseEtagList(condition: string): string[] {
  const tags: string[] = [];
  let quotedTokensPossible = true;
  let index = 0;
  while (index < condition.length) {
    const char = condition[index];
    if (char === '*') {
      tags.push('*');
      index += 1;
      continue;
    }
    if (char !== '"' || !quotedTokensPossible) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < condition.length) {
      if (condition[end] === '\\') {
        end += 2;
        continue;
      }
      if (condition[end] === '"') break;
      end += 1;
    }
    if (end >= condition.length) {
      // No unescaped closing quote remains, so no later quoted token can close either.
      quotedTokensPossible = false;
      index += 1;
      continue;
    }
    const quoteStart = condition[index - 1] === '/' && condition[index - 2] === 'W' ? index - 2 : index;
    tags.push(condition.slice(quoteStart, end + 1));
    index = end + 1;
  }
  return tags;
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
