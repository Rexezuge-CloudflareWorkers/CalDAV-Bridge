import type { ProviderCalendar } from '../types';
import { apiFetch, readJson } from '../lib/api';

export async function listCalendars(applicationId: string): Promise<ProviderCalendar[]> {
  const data = await readJson<{ calendars: ProviderCalendar[] }>(
    await apiFetch(`/user/application/calendars?applicationId=${encodeURIComponent(applicationId)}`),
  );
  return data.calendars;
}
