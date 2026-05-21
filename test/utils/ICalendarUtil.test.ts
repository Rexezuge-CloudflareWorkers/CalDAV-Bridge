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

  it('emits and parses recurrence rules', () => {
    const ics = ICalendarUtil.toICS({
      uid: 'event-1@example.test',
      summary: 'Weekly sync',
      start: { dateTime: '2026-05-04T10:00:00Z' },
      end: { dateTime: '2026-05-04T10:30:00Z' },
      recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5'],
    });

    expect(ics).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5');
    expect(ICalendarUtil.fromICS(ics, 'fallback').recurrence).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5']);
  });
});
