/**
 * A single-pass scanner for the subset of XML that CalDAV clients actually send.
 *
 * This exists because the tag scanner it replaces was a backtracking regular
 * expression. Its name character class did not exclude `<`, so a run of `<`
 * with no closing `>` made the engine consume the whole buffer and then
 * re-scan it one character shorter at a time -- cubic time. A ~4 KB request
 * body was enough to burn a Worker's entire CPU budget, and it was reachable
 * from every `PROPFIND` and `REPORT`.
 *
 * The scan here is strictly forward: every loop advances an index past the
 * character it just examined, so a body of `n` characters costs `O(n)` no
 * matter what those characters are. Malformed input is truncated, never
 * re-tried.
 *
 * A second, quieter job: property names arrive from the client and are echoed
 * back into the response as *element names*, where `escape` cannot help. Only
 * names this scanner can read as well-formed XML names are reported, so a
 * client can no longer inject markup into a `207 Multi-Status` document.
 */

/** XML names start with a letter or underscore; subsequent characters may also be digits, `.` or `-`. */
const NAME_START_CHARACTER = /[A-Za-z_]/;
const NAME_CHARACTER = /[A-Za-z0-9_.-]/;
/** A name must be followed by whitespace, the end of the tag, or a self-closing slash. */
const TAG_DELIMITER = /[\s/>]/;

interface DavXmlTag {
  /** The name with any namespace prefix removed, e.g. `calendar-data` for `C:calendar-data`. */
  localName: string;
  closing: boolean;
  selfClosing: boolean;
  /** The raw attribute text, empty when the tag carries none. */
  attributes: string;
  /** Index of the first character inside the element, or of its closing tag. */
  contentStart: number;
  /** Index just past the element's content, or of the end of input when unclosed. */
  contentEnd: number;
  /** Index of the innermost enclosing element, or -1 at the top level. */
  parent: number;
}

interface DavXmlDocument {
  tags: DavXmlTag[];
  source: string;
}

/**
 * Parse `xml` into a flat, ordered tag list with parent links.
 *
 * Unbalanced markup is tolerated rather than rejected: an unclosed element
 * simply runs to the end of input, and a stray closing tag is recorded with no
 * parent. CalDAV bodies are small and forgiving input, and a client that
 * sends something this cannot read is better served by a partial answer than
 * by a `400` it cannot act on.
 */
function parseDavXml(xml: string): DavXmlDocument {
  const tags: DavXmlTag[] = [];
  const openTags: number[] = [];
  let index = 0;

  while (index < xml.length) {
    const start = xml.indexOf('<', index);
    if (start < 0) break;
    index = start;

    // Processing instructions, comments, CDATA sections and doctypes carry no
    // properties or hrefs. Skipping them keeps their contents from being
    // mistaken for markup.
    if (xml.startsWith('<!--', index)) {
      index = skipPast(xml, index + 4, '-->');
      continue;
    }
    if (xml.startsWith('<![CDATA[', index)) {
      index = skipPast(xml, index + 9, ']]>');
      continue;
    }
    if (xml.startsWith('<?', index)) {
      index = skipPast(xml, index + 2, '?>');
      continue;
    }
    if (xml.startsWith('<!', index)) {
      index = skipPast(xml, index + 2, '>');
      continue;
    }

    const closing = xml[index + 1] === '/';
    const nameStart = index + (closing ? 2 : 1);
    const nameEnd = readNameEnd(xml, nameStart);
    // A `<` that does not begin a name is literal text, not the start of a tag.
    if (nameEnd === nameStart) {
      index = start + 1;
      continue;
    }

    // A name must be followed by a delimiter. If it is not, the run of name
    // characters was only the prefix of something malformed: `<foo&bar/>` would
    // otherwise be reported as the perfectly valid name `foo` and echoed back as
    // `<D:foo/>`, quietly answering a property the client never asked for.
    //
    // The whole malformed tag is skipped to its `>`, rather than resumed after
    // the name, because the tail of a broken tag can itself read as a valid
    // element. Siblings after it are still read, so one bad name costs only
    // that name; the caller reports the rest it cannot resolve in the 404
    // propstat. This runs before the tag is measured, because a malformed tag
    // can leave an attribute quote unbalanced and swallow everything after it.
    const delimiter = xml[nameEnd];
    if (delimiter !== undefined && !TAG_DELIMITER.test(delimiter)) {
      const nextDelimiter = xml.indexOf('>', nameEnd);
      if (nextDelimiter < 0) break;
      index = nextDelimiter + 1;
      continue;
    }

    const tagEnd = findTagEnd(xml, nameEnd);
    // An unterminated tag means the body was truncated in transit; there is
    // nothing further to read.
    if (tagEnd < 0) break;

    const name = xml.slice(nameStart, nameEnd);

    const selfClosing = xml[tagEnd - 1] === '/';
    const tag: DavXmlTag = {
      localName: localName(name),
      closing,
      selfClosing,
      attributes: xml.slice(nameEnd, selfClosing ? tagEnd - 1 : tagEnd).trim(),
      contentStart: tagEnd + 1,
      contentEnd: tagEnd + 1,
      parent: -1,
    };

    if (closing) {
      const openIndex = openTags.pop();
      if (openIndex !== undefined) {
        tags[openIndex].contentEnd = start;
        tag.parent = openIndex;
      }
    } else {
      tag.parent = openTags.length ? openTags[openTags.length - 1] : -1;
      if (!selfClosing) openTags.push(tags.length);
    }
    tags.push(tag);
    index = tagEnd + 1;
  }

  for (const openIndex of openTags) tags[openIndex].contentEnd = xml.length;
  return { tags, source: xml };
}

/** The name of the first element in `xml`, or `''` when there is none. */
function firstElementName(xml: string): string {
  const document = parseDavXml(xml);
  for (const tag of document.tags) if (!tag.closing) return tag.localName;
  return '';
}

/** The text inside the first non-closing `name` element, or `undefined`. */
function firstElementText(xml: string, name: string, unescape: (value: string) => string): string | undefined {
  const document = parseDavXml(xml);
  for (const tag of document.tags) {
    if (tag.closing || tag.localName !== name) continue;
    return unescape(document.source.slice(tag.contentStart, tag.contentEnd).trim());
  }
  return undefined;
}

/** The text inside every non-closing `name` element, in document order. */
function allElementTexts(xml: string, name: string, unescape: (value: string) => string): string[] {
  const document = parseDavXml(xml);
  const values: string[] = [];
  for (const tag of document.tags) {
    if (tag.closing || tag.localName !== name) continue;
    values.push(unescape(document.source.slice(tag.contentStart, tag.contentEnd).trim()));
  }
  return values;
}

/**
 * The names of the direct children of the first `container` element.
 *
 * Depth is resolved from the scanner's parent links rather than by re-scanning
 * the container's text, so a document is parsed exactly once regardless of how
 * deeply it nests.
 */
function directChildNames(xml: string, container: string): string[] {
  const document = parseDavXml(xml);
  let containerIndex = -1;
  for (let index = 0; index < document.tags.length; index += 1) {
    const tag = document.tags[index];
    if (!tag.closing && tag.localName === container) {
      containerIndex = index;
      break;
    }
  }
  if (containerIndex < 0) return [];

  const names: string[] = [];
  for (const tag of document.tags) {
    if (tag.closing || tag.parent !== containerIndex) continue;
    if (names.includes(tag.localName)) continue;
    names.push(tag.localName);
  }
  return names;
}

/** The raw attribute text of the first non-closing `name` element. */
function firstElementAttributes(xml: string, name: string): string | undefined {
  const document = parseDavXml(xml);
  for (const tag of document.tags) {
    if (tag.closing || tag.localName !== name) continue;
    return tag.attributes;
  }
  return undefined;
}

/** The value of `name="..."` within a raw attribute string. */
function attributeValue(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  return pattern.exec(attributes)?.[1];
}

function readNameEnd(xml: string, start: number): number {
  let index = start;
  if (index >= xml.length || !NAME_START_CHARACTER.test(xml[index] as string)) return start;
  index += 1;
  while (index < xml.length && (NAME_CHARACTER.test(xml[index] as string) || xml[index] === ':')) index += 1;
  // A trailing `:` belongs to no name.
  if (xml[index - 1] === ':') index -= 1;
  return index;
}

/**
 * Find the `>` that closes a tag, ignoring any that fall inside a quoted
 * attribute value -- `<x a=">">` is legal, and stopping at the inner `>` would
 * misparse every element after it.
 */
function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let index = from; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function skipPast(xml: string, from: number, terminator: string): number {
  const end = xml.indexOf(terminator, from);
  return end < 0 ? xml.length : end + terminator.length;
}

function localName(name: string): string {
  const separator = name.indexOf(':');
  return separator < 0 ? name : name.slice(separator + 1);
}

export { allElementTexts, attributeValue, directChildNames, firstElementAttributes, firstElementName, firstElementText, parseDavXml };
export type { DavXmlDocument, DavXmlTag };
