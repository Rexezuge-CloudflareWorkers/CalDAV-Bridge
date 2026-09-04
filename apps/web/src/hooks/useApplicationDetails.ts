import { useCallback, useState } from 'react';
import type { ApplicationStatus, CalDavCredential, ConnectedApplication, ProviderCalendar } from '../types';
import { listCredentials, createCredential, deleteCredential } from '../services/credentialService';
import { listCalendars } from '../services/calendarService';

export function useApplicationDetails({
  selectedApplication,
  showNotice,
}: {
  selectedApplication: ConnectedApplication | undefined;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const [credentials, setCredentials] = useState<CalDavCredential[]>([]);
  const [calendars, setCalendars] = useState<ProviderCalendar[]>([]);
  const [credentialName, setCredentialName] = useState('Desktop calendar');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<CalDavCredential | null>(null);

  const applicationId = selectedApplication?.applicationId;

  // Reset per-application UI state during render (React-endorsed derived-state
  // pattern) so switching applications never leaks the one-time password.
  const [lastApplicationId, setLastApplicationId] = useState<string | undefined>(applicationId);
  if (applicationId !== lastApplicationId) {
    setLastApplicationId(applicationId);
    setNewUsername('');
    setNewPassword('');
    setConfirmDelete(null);
    setCredentials([]);
    setCalendars([]);
  }

  // Called from SpaApp effects (mirroring Mail-Otter's view-load pattern) so
  // data fetching stays out of this hook's own effects.
  const loadDetails = useCallback(async (id: string, status: ApplicationStatus) => {
    const [nextCredentials, nextCalendars] = await Promise.all([
      listCredentials(id),
      status === 'connected' ? listCalendars(id) : Promise.resolve([] as ProviderCalendar[]),
    ]);
    setCredentials(nextCredentials);
    setCalendars(nextCalendars);
  }, []);

  const generateCredential = useCallback(async () => {
    if (!selectedApplication) return;
    const data = await createCredential(selectedApplication.applicationId, credentialName);
    setNewUsername(data.metadata.username);
    setNewPassword(data.password);
    showNotice('success', 'CalDAV Credentials Created. Save The Password Now; It Will Not Be Shown Again.');
    setCredentials(await listCredentials(selectedApplication.applicationId));
  }, [credentialName, selectedApplication, showNotice]);

  const removeCredential = useCallback(
    async (credentialId: string) => {
      if (!selectedApplication) return;
      await deleteCredential(selectedApplication.applicationId, credentialId);
      setConfirmDelete(null);
      showNotice('success', 'CalDAV Password Deleted.');
      setCredentials(await listCredentials(selectedApplication.applicationId));
    },
    [selectedApplication, showNotice],
  );

  return {
    credentials,
    calendars,
    credentialName,
    setCredentialName,
    newUsername,
    newPassword,
    confirmDelete,
    setConfirmDelete,
    loadDetails,
    generateCredential,
    removeCredential,
  };
}
