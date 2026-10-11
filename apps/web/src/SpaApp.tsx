import { useCallback, useEffect, useMemo, useState } from 'react';
import { NoticeBar, Unauthorized, useNotice } from '@rexezuge/web';
import type { Notice } from '@rexezuge/web';
import { Header } from './components/layout/Header';
import { ApplicationsView } from './components/views/ApplicationsView';
import { ConnectView } from './components/views/ConnectView';
import { ApplicationDetailView } from './components/views/ApplicationDetailView';
import { useCurrentUser } from './hooks/useCurrentUser';
import { useRouting } from './hooks/useRouting';
import { useApplications } from './hooks/useApplications';
import { useApplicationDetails } from './hooks/useApplicationDetails';
import { authorizeOAuth2 } from './services/oauthService';
import { parseRoute, routePath } from './types';

/**
 * Seed the first notice from the OAuth2 redirect result, if any.
 *
 * The `?oauth2=` parameter names are product-specific, so the kit's `useNotice`
 * leaves seeding to the consumer through its `initial` option rather than
 * reading the query string itself.
 */
export function getInitialNotice(search: string): Notice | null {
  const params = new URLSearchParams(search);
  if (params.get('oauth2') === 'connected') return { kind: 'success', message: 'OAuth2 Connection Completed.' };
  if (params.get('oauth2') === 'error') return { kind: 'error', message: params.get('message') || 'OAuth2 Connection Failed.' };
  return null;
}

export default function SpaApp() {
  const { route, navigate, replaceRoute } = useRouting();
  const [isBusy, setIsBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const { notice, showNotice } = useNotice({ initial: getInitialNotice(globalThis.location.search) });
  const { user, authorized } = useCurrentUser();
  const applications = useApplications({ showNotice });

  const selectedApplicationId = route.page === 'details' ? route.applicationId : undefined;
  const selectedApplication = useMemo(
    () =>
      selectedApplicationId
        ? applications.applications.find((application) => application.applicationId === selectedApplicationId)
        : undefined,
    [applications.applications, selectedApplicationId],
  );
  const selectedApplicationStatus = selectedApplication?.status;

  const details = useApplicationDetails({ selectedApplication, showNotice });

  // Handle OAuth2 redirect results once on mount, preserving pathname routing.
  useEffect(() => {
    const params = new URLSearchParams(globalThis.location.search);
    const oauthResult = params.get('oauth2');
    if (oauthResult === 'connected') {
      const connectedApplicationId = params.get('applicationId');
      if (connectedApplicationId) {
        const next = { page: 'details' as const, applicationId: connectedApplicationId };
        globalThis.history.replaceState(null, '', routePath(next));
        replaceRoute(next);
      }
    }
    if (oauthResult === 'error') {
      globalThis.history.replaceState(null, '', routePath(parseRoute(globalThis.location.pathname)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load applications once the user is authorized.
  useEffect(() => {
    if (authorized) {
      applications
        .loadApplications()
        .catch((error: unknown) => showNotice('error', error instanceof Error ? error.message : 'Unable To Load CalDAV Bridge.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized]);

  // Load view-specific data when the details view becomes visible (Mail-Otter pattern).
  useEffect(() => {
    if (route.page === 'details' && selectedApplicationId && selectedApplicationStatus) {
      details
        .loadDetails(selectedApplicationId, selectedApplicationStatus)
        .catch((error: unknown) => showNotice('error', error instanceof Error ? error.message : 'Unable To Load Application Details.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.page, selectedApplicationId, selectedApplicationStatus]);

  const handleSave = useCallback(async () => {
    setSubmitting(true);
    try {
      const application = await applications.saveApplication();
      navigate({ page: 'details', applicationId: application.applicationId });
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Unable To Create Application.');
    } finally {
      setSubmitting(false);
    }
  }, [applications, navigate, showNotice]);

  const handleOAuth2 = useCallback(async () => {
    if (!selectedApplication) return;
    setReconnecting(true);
    try {
      const authorizationUrl = await authorizeOAuth2(selectedApplication.applicationId);
      globalThis.location.assign(authorizationUrl);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Unable To Start OAuth2.');
      setReconnecting(false);
    }
  }, [selectedApplication, showNotice]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      await details.generateCredential();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Unable To Generate Credentials.');
    } finally {
      setGenerating(false);
    }
  }, [details, showNotice]);

  const handleConfirmDelete = useCallback(async () => {
    if (!details.confirmDelete) return;
    setIsBusy(true);
    try {
      await details.removeCredential(details.confirmDelete.credentialId);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Unable To Delete Credentials.');
    } finally {
      setIsBusy(false);
    }
  }, [details, showNotice]);

  if (authorized === null) {
    return (
      <div className="min-h-screen bg-[var(--color-surface-base)] flex items-center justify-center">
        <div className="h-10 w-10 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!authorized || !user) {
    return (
      <div className="min-h-screen bg-[var(--color-surface-base)] text-[var(--color-text-primary)] flex items-center justify-center">
        <Unauthorized
          title="Access Required"
          message="You Must Authenticate To Access This Application."
          actionLabel="Authenticate With Cloudflare Zero Trust"
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-surface-base)] text-[var(--color-text-primary)]">
      <Header route={route} onNavigate={navigate} userEmail={user.email} />

      {notice && <NoticeBar notice={notice} statusLabels={{ success: 'Success', error: 'Error' }} />}

      <main className="max-w-7xl mx-auto px-6 py-8">
        {route.page === 'applications' && (
          <ApplicationsView
            user={user}
            applications={applications.applications}
            onConnect={() => navigate({ page: 'connect' })}
            onOpen={(applicationId) => navigate({ page: 'details', applicationId })}
          />
        )}

        {route.page === 'connect' && (
          <ConnectView
            displayName={applications.displayName}
            setDisplayName={applications.setDisplayName}
            providerId={applications.providerId}
            setProviderId={applications.setProviderId}
            clientId={applications.clientId}
            setClientId={applications.setClientId}
            clientSecret={applications.clientSecret}
            setClientSecret={applications.setClientSecret}
            onSubmit={() => void handleSave()}
            onCancel={() => navigate({ page: 'applications' })}
            submitting={submitting}
          />
        )}

        {route.page === 'details' && (
          <ApplicationDetailView
            user={user}
            application={selectedApplication}
            credentials={details.credentials}
            calendars={details.calendars}
            credentialName={details.credentialName}
            setCredentialName={details.setCredentialName}
            newUsername={details.newUsername}
            newPassword={details.newPassword}
            confirmDelete={details.confirmDelete}
            setConfirmDelete={details.setConfirmDelete}
            onBack={() => navigate({ page: 'applications' })}
            onReconnect={() => void handleOAuth2()}
            onGenerate={() => void handleGenerate()}
            onConfirmDelete={() => void handleConfirmDelete()}
            generating={generating || isBusy}
            reconnecting={reconnecting}
          />
        )}
      </main>
    </div>
  );
}
