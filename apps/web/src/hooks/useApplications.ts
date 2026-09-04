import { useCallback, useState } from 'react';
import type { ConnectedApplication, ProviderId } from '../types';
import { createApplication, listApplications } from '../services/applicationService';

export function useApplications({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const [applications, setApplications] = useState<ConnectedApplication[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [providerId, setProviderId] = useState<ProviderId>('google-calendar');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  const loadApplications = useCallback(async (): Promise<ConnectedApplication[]> => {
    const next = await listApplications();
    setApplications(next);
    return next;
  }, []);

  const saveApplication = useCallback(async (): Promise<ConnectedApplication> => {
    const application = await createApplication({ displayName, providerId, clientId, clientSecret });
    showNotice('success', 'Application Created.');
    setDisplayName('');
    setClientId('');
    setClientSecret('');
    await loadApplications();
    return application;
  }, [clientId, clientSecret, displayName, loadApplications, providerId, showNotice]);

  return {
    applications,
    loadApplications,
    displayName,
    setDisplayName,
    providerId,
    setProviderId,
    clientId,
    setClientId,
    clientSecret,
    setClientSecret,
    saveApplication,
  };
}
