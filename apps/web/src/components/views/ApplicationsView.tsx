import { EmptyState } from '@rexezuge/web';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { ApplicationCard } from '../applications/ApplicationCard';
import type { ConnectedApplication, CurrentUser } from '../../types';

export function ApplicationsView({
  user,
  applications,
  onConnect,
  onOpen,
}: {
  user: CurrentUser;
  applications: ConnectedApplication[];
  onConnect: () => void;
  onOpen: (applicationId: string) => void;
}) {
  return (
    <section className="grid gap-4 animate-fade-in-up">
      <Card className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6">
        <div>
          <p className="text-xs font-bold tracking-widest uppercase text-[var(--color-accent)] mb-2">Calendar Connections</p>
          <h1 className="text-4xl font-bold tracking-tight text-[var(--color-text-primary)]">Applications</h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-2">
            Manage OAuth Calendar Applications And Open Each One For CalDAV Credentials And Calendars.
          </p>
        </div>
        <Button onClick={onConnect} size="lg" className="shrink-0">
          Connect Calendar
        </Button>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your Applications</CardTitle>
          <span className="text-sm text-[var(--color-text-muted)]">
            {applications.length}/{user.limits.maxApplicationsPerUser}
          </span>
        </CardHeader>
        {applications.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {applications.map((application, index) => (
              <div
                key={application.applicationId}
                className={index === 0 ? 'animate-stagger-1' : index === 1 ? 'animate-stagger-2' : 'animate-stagger-3'}
              >
                <ApplicationCard application={application} onOpen={() => onOpen(application.applicationId)} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            message={
              <div className="grid justify-items-start gap-2">
                <h3 className="text-base font-semibold text-[var(--color-text-primary)]">No Applications Yet</h3>
                <p className="text-sm text-[var(--color-text-secondary)]">
                  Create An Application To Connect Google Calendar Or Outlook Calendar.
                </p>
                <Button onClick={onConnect}>Connect Calendar</Button>
              </div>
            }
          />
        )}
      </Card>
    </section>
  );
}
