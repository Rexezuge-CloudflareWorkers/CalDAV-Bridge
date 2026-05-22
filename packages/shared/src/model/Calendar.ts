interface ProviderCalendar {
  id: string;
  name: string;
  description?: string | undefined;
  timeZone?: string | undefined;
  readOnly?: boolean | undefined;
  etag?: string | undefined;
}

interface CalendarEventDateTime {
  date?: string | undefined;
  dateTime?: string | undefined;
  timeZone?: string | undefined;
}

interface CalendarAttendee {
  email: string;
  name?: string | undefined;
}

interface CalendarEvent {
  id?: string | undefined;
  uid: string;
  etag?: string | undefined;
  recurrenceId?: CalendarEventDateTime | undefined;
  summary?: string | undefined;
  description?: string | undefined;
  location?: string | undefined;
  status?: string | undefined;
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
  created?: string | undefined;
  updated?: string | undefined;
  recurrence?: string[] | undefined;
  attendees?: CalendarAttendee[] | undefined;
  overrides?: CalendarEvent[] | undefined;
}

interface CalendarObjectMappingInternal {
  object_id: string;
  application_id: string;
  calendar_id: string;
  href: string;
  provider_event_id: string;
  uid: string;
  etag: string | null;
  created_at: number;
  updated_at: number;
}

export type { CalendarAttendee, CalendarEvent, CalendarEventDateTime, CalendarObjectMappingInternal, ProviderCalendar };
