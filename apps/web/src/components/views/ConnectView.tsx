import { ConnectForm } from '../applications/ConnectForm';
import type { ProviderId } from '../../types';

export function ConnectView({
  displayName,
  setDisplayName,
  providerId,
  setProviderId,
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
  onSubmit,
  onCancel,
  submitting,
}: {
  displayName: string;
  setDisplayName: (value: string) => void;
  providerId: ProviderId;
  setProviderId: (value: ProviderId) => void;
  clientId: string;
  setClientId: (value: string) => void;
  clientSecret: string;
  setClientSecret: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  return (
    <section className="grid gap-4 max-w-3xl mx-auto animate-fade-in-up">
      <div className="px-1 pt-2">
        <p className="text-xs font-bold tracking-widest uppercase text-[var(--color-accent)] mb-2">New Connection</p>
        <h1 className="text-4xl font-bold tracking-tight text-[var(--color-text-primary)]">Connect Calendar</h1>
        <p className="text-sm text-[var(--color-text-secondary)] mt-2">
          Create One OAuth Application At A Time. You Can Connect OAuth2 And Generate CalDAV App Passwords After It Is Saved.
        </p>
      </div>
      <ConnectForm
        displayName={displayName}
        setDisplayName={setDisplayName}
        providerId={providerId}
        setProviderId={setProviderId}
        clientId={clientId}
        setClientId={setClientId}
        clientSecret={clientSecret}
        setClientSecret={setClientSecret}
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitting={submitting}
      />
    </section>
  );
}
