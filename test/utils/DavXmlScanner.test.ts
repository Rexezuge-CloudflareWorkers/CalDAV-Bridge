import { describe, expect, it } from 'vitest';
import {
  allElementTexts,
  directChildNames,
  firstElementName,
  firstElementText,
  parseDavXml,
} from '@caldav-bridge/backend-services/calendar/DavXmlScanner';

const unescape = (value: string): string => value;

describe('DavXmlScanner', () => {
  it('reads the first element name regardless of namespace prefix', () => {
    expect(firstElementName('<D:propfind xmlns:D="DAV:"><D:prop/></D:propfind>')).toBe('propfind');
    expect(firstElementName('<?xml version="1.0"?><multistatus xmlns="DAV:"><response/></multistatus>')).toBe('multistatus');
    expect(firstElementName('not xml at all')).toBe('');
  });

  it('returns only the direct children of the named container', () => {
    const body =
      '<C:calendar-query><D:prop><D:getetag/><C:calendar-data/><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>';

    expect(directChildNames(body, 'prop')).toEqual(['getetag', 'calendar-data']);
    // A name that also appears as a nested child must not leak into the list.
    expect(directChildNames('<D:prop><D:a><D:a/></D:a><D:b/></D:prop>', 'prop')).toEqual(['a', 'b']);
    expect(directChildNames(body, 'absent')).toEqual([]);
  });

  it('extracts element text and honours self-closing elements', () => {
    const body = '<D:multistatus><D:response><D:href>/dav/a.ics</D:href></D:response><D:href>/dav/b.ics</D:href></D:multistatus>';

    expect(firstElementText(body, 'href', unescape)).toBe('/dav/a.ics');
    expect(allElementTexts(body, 'href', unescape)).toEqual(['/dav/a.ics', '/dav/b.ics']);
    expect(firstElementText(body, 'sync-token', unescape)).toBeUndefined();
  });

  it('does not let a `>` inside a quoted attribute value end the tag early', () => {
    const body = '<D:prop a="1 > 0" b=\'x>y\'><D:getetag/><D:calendar-data/></D:prop>';

    expect(directChildNames(body, 'prop')).toEqual(['getetag', 'calendar-data']);
  });

  it('ignores comments, CDATA and processing instructions', () => {
    const body = '<D:prop><!-- <D:fake/> --><![CDATA[<D:alsofake/>]]><D:getetag/></D:prop>';

    expect(directChildNames(body, 'prop')).toEqual(['getetag']);
  });

  it('tolerates unbalanced markup by truncating rather than throwing', () => {
    expect(directChildNames('<D:prop><D:getetag/>', 'prop')).toEqual(['getetag']);
    expect(directChildNames('</D:prop><D:getetag/>', 'prop')).toEqual([]);
    expect(() => parseDavXml('<D:prop')).not.toThrow();
  });

  /**
   * The scanner replaced a backtracking regular expression whose name class did
   * not exclude `<`, so a run of `<` with no closing `>` cost cubic time: 3000
   * characters took over 20 seconds, which is enough to burn a Worker's entire
   * CPU budget from a ~4 KB request body. This asserts the replacement is linear
   * and bounds the damage if a regression reintroduces a backtrack.
   */
  it('parses a hostile run of unmatched angle brackets in linear time', () => {
    const payload = `<D:prop>${'<'.repeat(64 * 1024)}`;

    const startedAt = performance.now();
    const names = directChildNames(payload, 'prop');
    const elapsed = performance.now() - startedAt;

    expect(names).toEqual([]);
    expect(elapsed).toBeLessThan(250);
  });

  it('parses a deeply nested body in linear time', () => {
    const depth = 2000;
    const payload = '<D:prop>'.repeat(depth) + '</D:prop>'.repeat(depth);

    const startedAt = performance.now();
    const document = parseDavXml(payload);
    const elapsed = performance.now() - startedAt;

    expect(document.tags.length).toBe(depth * 2);
    expect(elapsed).toBeLessThan(250);
  });

  /**
   * Property names are echoed back as element *names*, where XML escaping cannot
   * help. Only names the scanner can read as well-formed XML names may be
   * reported, so a client cannot inject markup into a Multi-Status document.
   */
  it('rejects names that are not well-formed XML names', () => {
    const body = '<D:prop><foo&bar/><x"y/><a&<b/><D:good-name/><_ok/><D:n1/></D:prop>';

    expect(directChildNames(body, 'prop')).toEqual(['good-name', '_ok', 'n1']);
  });
});
