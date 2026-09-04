import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../shared/EmptyState';
import { ConnectionDetails } from '../applications/ConnectionDetails';
import { CredentialsSection } from '../applications/CredentialsSection';
import { CalendarsSection } from '../applications/CalendarsSection';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';
import { providerLabels, type CalDavCredential, type ConnectedApplication, type CurrentUser, type ProviderCalendar } from '../../types';

export function ApplicationDetailView({
  user,
  application,
  credentials,
  calendars,
  credentialName,
  setCredentialName,
  newUsername,
  newPassword,
  confirmDelete,
  setConfirmDelete,
  onBack,
  onReconnect,
  onGenerate,
  onConfirmDelete,
  generating,
  reconnecting,
}: {
  user: CurrentUser;
  application: ConnectedApplication | undefined;
  credentials: CalDavCredential[];
  calendars: ProviderCalendar[];
  credentialName: string;
  setCredentialName: (value: string) => void;
  newUsername: string;
  newPassword: string;
  confirmDelete: CalDavCredential | null;
  setConfirmDelete: (credential: CalDavCredential | null) => void;
  onBack: () => void;
  onReconnect: () => void;
  onGenerate: () => void;
  onConfirmDelete: () => void;
  generating: boolean;
  reconnecting: boolean;
}) {
  if (!application) {
    return (
      <EmptyState
        title="Application Not Found"
        description="The Selected Application Could Not Be Found For Your Account."
        action={<Button onClick={onBack}>Back To Applications</Button>}
      />
    );
  }

  return (
    <section className="grid gap-3 animate-fade-in-up">
      <Card className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 sm:px-4 sm:py-3.5">
        <div className="min-w-0">
          <button type="button" onClick={onBack} className="w-fit mb-2 -ml-2 px-2 py-1 rounded-lg text-sm bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] transition-colors">
            Back To Applications
          </button>
          <p className="text-xs font-bold tracking-widest uppercase text-[var(--color-accent)] mb-1">{providerLabels[application.providerId]}</p>
          <h1 className="text-3xl font-bold tracking-tight text-[var(--color-text-primary)] break-words">{application.displayName}</h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">{application.providerEmail || 'OAuth Is Not Connected Yet.'}</p>
        </div>
        <Button onClick={onReconnect} loading={reconnecting} className="shrink-0">
          {application.status === 'connected' ? 'Reconnect OAuth2' : 'Connect OAuth2'}
        </Button>
      </Card>

      <Card>
        <ConnectionDetails application={application} />
      </Card>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(260px,0.75fr)] items-start">
        <CredentialsSection
          credentials={credentials}
          maxCredentials={user.limits.maxCalDavCredentialsPerApplication}
          credentialName={credentialName}
          setCredentialName={setCredentialName}
          newUsername={newUsername}
          newPassword={newPassword}
          onGenerate={onGenerate}
          onDelete={(credential) => setConfirmDelete(credential)}
          generating={generating}
        />
        <CalendarsSection calendars={calendars} />
      </div>

      {confirmDelete && typeof document !== 'undefined' && (
        <ConfirmDeleteModal
          displayName={confirmDelete.name}
          onConfirm={onConfirmDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </section>
  );
}
