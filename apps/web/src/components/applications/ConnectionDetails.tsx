import type { ConnectedApplication } from '../../types';
import { ConnectionBadge } from '../ui/Badge';
import { CopyField } from '../shared/CopyField';

export function ConnectionDetails({ application }: { application: ConnectedApplication }) {
  return (
    <div className="grid gap-6 md:grid-cols-[minmax(180px,0.55fr)_minmax(0,1fr)]">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1">Connection Details</h2>
        <p className="text-sm text-[var(--color-text-secondary)]">Use These Values When Configuring The OAuth Provider And CalDAV Client.</p>
      </div>
      <div className="grid gap-4 min-w-0">
        <div className="grid gap-1 pb-4 border-b border-[var(--color-border)]">
          <span className="text-xs text-[var(--color-text-muted)]">Status</span>
          <ConnectionBadge status={application.status} />
        </div>
        <CopyField label="Redirect URI" value={application.oauth2RedirectUri} />
        <CopyField label="CalDAV URL" value={application.caldavBaseUrl} />
      </div>
    </div>
  );
}
