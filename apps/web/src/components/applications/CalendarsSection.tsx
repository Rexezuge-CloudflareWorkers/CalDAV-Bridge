import { Card, CardHeader, CardTitle } from '../ui/Card';
import type { ProviderCalendar } from '../../types';

export function CalendarsSection({ calendars }: { calendars: ProviderCalendar[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Calendars</CardTitle>
        <span className="text-sm text-[var(--color-text-muted)]">{calendars.length}</span>
      </CardHeader>
      {calendars.length ? (
        <div className="grid gap-2 max-h-[17rem] overflow-auto pr-0.5">
          {calendars.map((calendar) => (
            <div key={calendar.id} className="grid gap-1 min-w-0 p-3 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)]">
              <strong className="break-words text-sm text-[var(--color-text-primary)]">{calendar.name}</strong>
              <small className="text-xs text-[var(--color-text-secondary)]">
                {calendar.timeZone || 'Provider Timezone'} {calendar.readOnly ? '· Read-Only' : ''}
              </small>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[var(--color-text-secondary)]">Calendars Will Appear Here After OAuth2 Is Connected.</p>
      )}
    </Card>
  );
}
