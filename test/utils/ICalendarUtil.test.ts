import { describe, expect, it } from 'vitest';
import { ICalendarUtil } from '@/utils';

describe('ICalendarUtil', () => {
  it('round trips core VEVENT fields', () => {
    const ics = ICalendarUtil.toICS({
      uid: 'event-1@example.test',
      summary: 'Planning',
      description: 'Roadmap review',
      location: 'Conference Room',
      start: { dateTime: '2026-01-02T03:04:05Z' },
      end: { dateTime: '2026-01-02T04:04:05Z' },
    });

    const parsed = ICalendarUtil.fromICS(ics, 'fallback');
    expect(parsed.uid).toBe('event-1@example.test');
    expect(parsed.summary).toBe('Planning');
    expect(parsed.location).toBe('Conference Room');
  });
});
