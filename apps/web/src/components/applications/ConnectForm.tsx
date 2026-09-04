import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Input';
import { Card } from '../ui/Card';
import type { ProviderId } from '../../types';

export function ConnectForm({
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
    <Card>
      <div className="grid gap-4">
        <div>
          <Label className="mb-1.5" htmlFor="connect-name">Name</Label>
          <Input
            id="connect-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Work Calendar"
          />
        </div>
        <div>
          <Label className="mb-1.5" htmlFor="connect-provider">Provider</Label>
          <Select id="connect-provider" value={providerId} onChange={(event) => setProviderId(event.target.value as ProviderId)}>
            <option value="google-calendar">Google Calendar</option>
            <option value="microsoft-outlook-calendar">Outlook Calendar</option>
          </Select>
        </div>
        <div>
          <Label className="mb-1.5" htmlFor="connect-client-id">OAuth Client ID</Label>
          <Input id="connect-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} />
        </div>
        <div>
          <Label className="mb-1.5" htmlFor="connect-client-secret">OAuth Client Secret</Label>
          <Input
            id="connect-client-secret"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            type="password"
          />
        </div>
        <div className="flex flex-col sm:flex-row gap-3 sm:justify-start mt-1">
          <Button onClick={onSubmit} loading={submitting}>
            Create Application
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
