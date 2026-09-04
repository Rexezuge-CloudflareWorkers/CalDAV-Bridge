import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { formatExpiryTimestamp, formatTimestamp } from '../../lib/api';
import type { CalDavCredential } from '../../types';

export function CredentialsSection({
  credentials,
  maxCredentials,
  credentialName,
  setCredentialName,
  newUsername,
  newPassword,
  onGenerate,
  onDelete,
  generating,
}: {
  credentials: CalDavCredential[];
  maxCredentials: number;
  credentialName: string;
  setCredentialName: (value: string) => void;
  newUsername: string;
  newPassword: string;
  onGenerate: () => void;
  onDelete: (credential: CalDavCredential) => void;
  generating: boolean;
}) {
  return (
    <Card>
      <CardHeader className="items-start">
        <div>
          <CardTitle>CalDAV App Passwords</CardTitle>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">Generate Per-Client Credentials After OAuth2 Is Connected.</p>
        </div>
        <span className="text-sm text-[var(--color-text-muted)] shrink-0">
          {credentials.length}/{maxCredentials}
        </span>
      </CardHeader>

      <div className="flex items-center gap-2">
        <Input value={credentialName} onChange={(event) => setCredentialName(event.target.value)} placeholder="Desktop Calendar" aria-label="Credential Name" />
        <Button onClick={onGenerate} loading={generating} className="shrink-0">
          Generate
        </Button>
      </div>

      {newPassword && (
        <div className="mt-4 p-3 rounded-lg bg-[var(--color-info-bg)] grid gap-1.5 max-h-32 overflow-auto">
          <span className="text-sm"><strong className="text-[var(--color-text-primary)]">New Username: </strong><code className="text-[var(--color-info-text)] break-all">{newUsername}</code></span>
          <span className="text-sm"><strong className="text-[var(--color-text-primary)]">New Password: </strong><code className="text-[var(--color-info-text)] break-all">{newPassword}</code></span>
        </div>
      )}

      {credentials.length ? (
        <div className="w-full overflow-x-auto mt-2 max-h-60 overflow-y-auto">
          <table className="w-full min-w-[640px] border-collapse mt-1">
            <thead>
              <tr>
                <th className="py-2 pr-2 text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Name</th>
                <th className="py-2 pr-2 text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Username</th>
                <th className="py-2 pr-2 text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Password</th>
                <th className="py-2 pr-2 text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Expires</th>
                <th className="py-2 pr-2 text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Last Used</th>
                <th className="py-2 text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Action</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((credential) => (
                <tr key={credential.credentialId} className="border-t border-[var(--color-border)]">
                  <td className="py-2 pr-2 text-sm align-top">{credential.name}</td>
                  <td className="py-2 pr-2 align-top"><code className="text-[var(--color-success-text)] break-all text-xs">{credential.username}</code></td>
                  <td className="py-2 pr-2 align-top"><code className="text-[var(--color-success-text)] text-xs">{credential.passwordPrefix}...{credential.passwordLastFour}</code></td>
                  <td className="py-2 pr-2 text-sm text-[var(--color-text-secondary)] align-top whitespace-nowrap">{formatExpiryTimestamp(credential.expiresAt)}</td>
                  <td className="py-2 pr-2 text-sm text-[var(--color-text-secondary)] align-top whitespace-nowrap">{formatTimestamp(credential.lastUsedAt)}</td>
                  <td className="py-2 align-top">
                    <Button variant="danger" size="sm" onClick={() => onDelete(credential)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-[var(--color-text-secondary)] mt-3">No CalDAV App Passwords Have Been Generated For This Application.</p>
      )}
    </Card>
  );
}
