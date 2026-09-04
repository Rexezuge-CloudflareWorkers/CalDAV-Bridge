import { cn } from '../../lib/utils';
import { ConnectionBadge } from '../ui/Badge';
import type { ConnectedApplication } from '../../types';
import { providerLabels } from '../../types';

export function ApplicationCard({
  application,
  onOpen,
}: {
  application: ConnectedApplication;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'w-full min-w-0 text-left grid gap-2 p-4 rounded-xl border border-[var(--color-border)]',
        'bg-[var(--color-surface-2)] text-[var(--color-text-primary)] transition-colors duration-150',
        'hover:bg-[var(--color-surface-3)] hover:border-[var(--color-accent)]',
      )}
    >
      <ConnectionBadge status={application.status} />
      <strong className="break-words">{application.displayName}</strong>
      <small className="text-[var(--color-text-secondary)]">{providerLabels[application.providerId]}</small>
      <small className="text-[var(--color-text-secondary)]">{application.providerEmail || 'OAuth Not Connected'}</small>
      <span className="text-xs text-[var(--color-text-muted)]">{application.credentialCount || 0} App Passwords</span>
    </button>
  );
}
