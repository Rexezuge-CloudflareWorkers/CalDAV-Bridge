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

  it('escapes CRLF, CR, and LF inside text properties without creating invalid physical lines', () => {
    const ics = ICalendarUtil.toICS({
      uid: 'event-1@example.test',
      summary: 'One\\Two, Three; Four\nFive\rSix\r\nSeven',
      description: '<html>\r\n<head>\r<meta name="color-scheme" content="light dark">\n</head>\r\n<body>change &quot;Other notifications&quot;.</body>\r\n</html>',
      location: 'Room A\r\nRoom B',
      start: { dateTime: '2026-05-04T10:00:00Z' },
      end: { dateTime: '2026-05-04T10:30:00Z' },
    });
    const unfolded = unfold(ics);

    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(unfolded).toContain('SUMMARY:One\\\\Two\\, Three\\; Four\\nFive\\nSix\\nSeven');
    expect(unfolded).toContain('DESCRIPTION:<html>\\n<head>\\n<meta name="color-scheme" content="light dark">\\n</head>\\n<body>change &quot\\;Other notifications&quot\\;.</body>\\n</html>');
    expect(unfolded).toContain('LOCATION:Room A\\nRoom B');
  });

  it('folds long content using iCalendar continuation lines', () => {
    const summary = 'A'.repeat(160);
    const ics = ICalendarUtil.toICS({
      uid: 'event-1@example.test',
      summary,
      start: { dateTime: '2026-05-04T10:00:00Z' },
      end: { dateTime: '2026-05-04T10:30:00Z' },
    });

    expect(ics.split('\r\n').some((line) => line.startsWith(' '))).toBe(true);
    expect(unfold(ics)).toContain(`SUMMARY:${summary}`);
  });

  it('parses folded text, all-day dates, statuses, and recurrence lines', () => {
    const parsed = ICalendarUtil.fromICS(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:event-1@example.test',
        'SUMMARY:Planning',
        ' review',
        'DESCRIPTION:Line one\\nLine two',
        'STATUS:CONFIRMED',
        'DTSTART;VALUE=DATE:20260504',
        'DTEND;VALUE=DATE:20260505',
        'RRULE:FREQ=DAILY;COUNT=2',
        'EXDATE:20260506T100000Z',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
      'fallback',
    );

    expect(parsed).toMatchObject({
      uid: 'event-1@example.test',
      summary: 'Planningreview',
      description: 'Line one\nLine two',
      status: 'confirmed',
      start: { date: '2026-05-04' },
      end: { date: '2026-05-05' },
      recurrence: ['RRULE:FREQ=DAILY;COUNT=2', 'EXDATE:20260506T100000Z'],
    });
  });

  it('preserves TZID local event times without converting them to UTC', () => {
    const parsed = ICalendarUtil.fromICS(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:event-1@example.test',
        'DTSTART;TZID=America/Chicago:20260522T100000',
        'DTEND;TZID=America/Chicago:20260522T110000',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
      'fallback',
    );

    expect(parsed.start).toEqual({ dateTime: '2026-05-22T10:00:00', timeZone: 'America/Chicago' });
    expect(parsed.end).toEqual({ dateTime: '2026-05-22T11:00:00', timeZone: 'America/Chicago' });
  });

  it('keeps floating event times as floating times', () => {
    const parsed = ICalendarUtil.fromICS(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:event-1@example.test',
        'DTSTART:20260522T100000',
        'DTEND:20260522T110000',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
      'fallback',
    );

    expect(parsed.start).toEqual({ dateTime: '2026-05-22T10:00:00' });
    expect(parsed.end).toEqual({ dateTime: '2026-05-22T11:00:00' });
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

  it('emits recurrence override VEVENTs with recurrence ids', () => {
    const ics = ICalendarUtil.toICS({
      uid: 'series@example.test',
      summary: 'Weekly sync',
      start: { dateTime: '2026-05-04T10:00:00Z' },
      end: { dateTime: '2026-05-04T10:30:00Z' },
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'],
      overrides: [
        {
          uid: 'series@example.test',
          recurrenceId: { dateTime: '2026-05-11T10:00:00Z', timeZone: 'UTC' },
          summary: 'Moved sync',
          start: { dateTime: '2026-05-11T11:00:00Z' },
          end: { dateTime: '2026-05-11T11:30:00Z' },
        },
      ],
    });
    const unfolded = unfold(ics);

    expect(unfolded.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(unfolded).toContain('RRULE:FREQ=WEEKLY;COUNT=3');
    expect(unfolded).toContain('RECURRENCE-ID:20260511T100000Z');
    expect(unfolded).toContain('SUMMARY:Moved sync');
  });

  it('emits display alarms for event reminders', () => {
    const ics = ICalendarUtil.toICS({
      uid: 'event-1@example.test',
      summary: 'Planning',
      start: { dateTime: '2026-05-04T10:00:00Z' },
      end: { dateTime: '2026-05-04T10:30:00Z' },
      alarms: [{ triggerMinutesBeforeStart: 15 }],
    });
    const unfolded = unfold(ics);

    expect(unfolded).toContain('BEGIN:VALARM');
    expect(unfolded).toContain('ACTION:DISPLAY');
    expect(unfolded).toContain('DESCRIPTION:Planning');
    expect(unfolded).toContain('TRIGGER:-PT15M');
    expect(unfolded).toContain('END:VALARM');
  });

  it('parses display alarms from CalDAV writes without using alarm text as event description', () => {
    const parsed = ICalendarUtil.fromICS(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:event-1@example.test',
        'SUMMARY:Planning',
        'DTSTART:20260504T100000Z',
        'DTEND:20260504T103000Z',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'DESCRIPTION:Local reminder',
        'TRIGGER;RELATED=START:-PT1H30M',
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
      'fallback',
    );

    expect(parsed.description).toBeUndefined();
    expect(parsed.alarms).toEqual([{ triggerMinutesBeforeStart: 90, description: 'Local reminder' }]);
  });

  it('round trips event reminders through iCalendar parsing', () => {
    const parsed = ICalendarUtil.fromICS(
      ICalendarUtil.toICS({
        uid: 'event-1@example.test',
        summary: 'Planning',
        start: { dateTime: '2026-05-04T10:00:00Z' },
        end: { dateTime: '2026-05-04T10:30:00Z' },
        alarms: [{ triggerMinutesBeforeStart: 15, description: 'Custom reminder' }],
      }),
      'fallback',
    );

    expect(parsed.alarms).toEqual([{ triggerMinutesBeforeStart: 15, description: 'Custom reminder' }]);
  });

  it('ignores alarm triggers that cannot map to minutes before start', () => {
    const parsed = ICalendarUtil.fromICS(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:event-1@example.test',
        'DTSTART:20260504T100000Z',
        'DTEND:20260504T103000Z',
        'BEGIN:VALARM',
        'TRIGGER;VALUE=DATE-TIME:20260504T094500Z',
        'END:VALARM',
        'BEGIN:VALARM',
        'TRIGGER;RELATED=END:-PT5M',
        'END:VALARM',
        'BEGIN:VALARM',
        'TRIGGER:PT5M',
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
      'fallback',
    );

    expect(parsed.alarms).toBeUndefined();
  });

  it('quotes attendee CN parameters with iCalendar-safe escaping', () => {
    const ics = ICalendarUtil.toICS({
      uid: 'event-1@example.test',
      start: { dateTime: '2026-05-04T10:00:00Z' },
      end: { dateTime: '2026-05-04T10:30:00Z' },
      attendees: [
        { email: 'comma@example.test', name: 'Doe, Jane' },
        { email: 'semicolon@example.test', name: 'Team; Group' },
        { email: 'colon@example.test', name: 'Office: Hours' },
        { email: 'quote@example.test', name: 'The "Quoted" Team' },
      ],
    });

    expect(ics).toContain('ATTENDEE;CN="Doe, Jane":mailto:comma@example.test');
    expect(ics).toContain('ATTENDEE;CN="Team; Group":mailto:semicolon@example.test');
    expect(ics).toContain('ATTENDEE;CN="Office: Hours":mailto:colon@example.test');
    expect(ics).toContain('ATTENDEE;CN="The ^\'Quoted^\' Team":mailto:quote@example.test');
  });

  it('uses attendee email as CN fallback and caret-escapes parameter newlines', () => {
    const ics = ICalendarUtil.toICS({
      uid: 'event-1@example.test',
      start: { dateTime: '2026-05-04T10:00:00Z' },
      end: { dateTime: '2026-05-04T10:30:00Z' },
      attendees: [
        { email: 'fallback@example.test' },
        { email: 'newline@example.test', name: 'Line\r\nBreak' },
      ],
    });

    expect(unfold(ics)).toContain('ATTENDEE;CN="fallback@example.test":mailto:fallback@example.test');
    expect(unfold(ics)).toContain('ATTENDEE;CN="Line^nBreak":mailto:newline@example.test');
  });
});

function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, '');
}
