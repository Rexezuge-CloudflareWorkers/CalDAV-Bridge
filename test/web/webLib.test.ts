import { describe, expect, it } from 'vitest';
import { cn } from '~/lib/utils';
import { NOTICE_TIMEOUT_MS } from '~/lib/constants';
import { parseRoute, providerLabels, routePath } from '~/types';
import type { ProviderId } from '~/types';

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('drops falsy values rather than emitting them', () => {
    // A conditional class is written as `condition && 'x'`; a falsy value left in
    // would reach the DOM as the literal text "false".
    expect(cn('a', false && 'b', null, undefined, 'c')).toBe('a c');
  });

  it('lets a later class win over an earlier conflicting one', () => {
    // Tailwind conflicts are resolved by source order, so `twMerge` has to drop
    // the earlier one or both would be emitted and the winner would be whichever
    // the stylesheet happened to load last.
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('keeps classes that do not conflict', () => {
    expect(cn('flex', 'p-4', 'items-center')).toBe('flex p-4 items-center');
  });
});

describe('notice timeout', () => {
  it('is long enough to read a message', () => {
    // A notice that clears before it can be read is worse than one that lingers;
    // the bar is dismissal, not timeout.
    expect(NOTICE_TIMEOUT_MS).toBeGreaterThanOrEqual(3000);
  });
});

describe('route parsing', () => {
  it('recognises each route it can produce', () => {
    expect(parseRoute('/user/apps')).toEqual({ page: 'applications' });
    expect(parseRoute('/user/connect')).toEqual({ page: 'connect' });
    expect(parseRoute('/user/apps/app-1')).toEqual({ page: 'details', applicationId: 'app-1' });
  });

  it('round-trips every route', () => {
    for (const route of [
      { page: 'applications' } as const,
      { page: 'connect' } as const,
      { page: 'details', applicationId: 'app-1' } as const,
    ]) {
      expect(parseRoute(routePath(route))).toEqual(route);
    }
  });

  /**
   * Application ids are UUIDs, but an id arriving from a URL is attacker- or
   * typo-controlled. Encoding on the way out and decoding on the way in is what
   * keeps a nested id from being truncated at a separator and looking up the wrong
   * application.
   */
  it('round-trips an id containing a separator or a space', () => {
    for (const applicationId of ['nested/id', 'with space', 'a?b', 'a#b', 'ünïcode']) {
      expect(parseRoute(routePath({ page: 'details', applicationId }))).toEqual({ page: 'details', applicationId });
    }
  });

  it('ignores a trailing slash', () => {
    expect(parseRoute('/user/connect/')).toEqual({ page: 'connect' });
    expect(parseRoute('/user/apps/')).toEqual({ page: 'applications' });
  });

  /**
   * An unrecognised path falls back to the applications list rather than a 404.
   * A stale bookmark or a hand-edited URL should land somewhere usable.
   */
  it('falls back to the applications view for an unknown path', () => {
    for (const path of ['/', '/user', '/user/nonsense', '/user/apps/a/b/c', '']) {
      expect(parseRoute(path)).toEqual({ page: 'applications' });
    }
  });
});

describe('providerLabels', () => {
  it('names every provider the API accepts', () => {
    // A provider added to the API without a label here would render as
    // `undefined` in the connect form.
    const providerIds: ProviderId[] = ['google-calendar', 'microsoft-outlook-calendar'];
    for (const providerId of providerIds) {
      expect(providerLabels[providerId]).toBeTruthy();
    }
    expect(Object.keys(providerLabels)).toHaveLength(providerIds.length);
  });
});
