import { useCallback, useEffect, useMemo, useState } from 'react';
import Unauthorized from './components/Unauthorized';
import { Header } from './components/layout/Header';
import { NoticeBar } from './components/layout/NoticeBar';
import { ApplicationsView } from './components/views/ApplicationsView';
import { ConnectView } from './components/views/ConnectView';
import { ApplicationDetailView } from './components/views/ApplicationDetailView';
import { NoticeContext } from './contexts/NoticeContext';
import { UserContext } from './contexts/UserContext';
import { useNotice } from './hooks/useNotice';
import { useCurrentUser } from './hooks/useCurrentUser';
import { useRouting } from './hooks/useRouting';
import { useApplications } from './hooks/useApplications';
import { useApplicationDetails } from './hooks/useApplicationDetails';
import { authorizeOAuth2 } from './services/oauthService';
import { parseRoute, routePath } from './types';

export default function SpaApp() {
  const { route, navigate, replaceRoute } = useRouting();
  const [isBusy, setIsBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const { notice, showNotice } = useNotice();
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
      applications.loadApplications().catch((error: unknown) =>
        showNotice('error', error instanceof Error ? error.message : 'Unable To Load CalDAV Bridge.'),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized]);

  // Load view-specific data when the details view becomes visible (Mail-Otter pattern).
  useEffect(() => {
    if (route.page === 'details' && selectedApplicationId && selectedApplicationStatus) {
      details
        .loadDetails(selectedApplicationId, selectedApplicationStatus)
        .catch((error: unknown) =>
          showNotice('error', error instanceof Error ? error.message : 'Unable To Load Application Details.'),
        );
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

  if (!authorized || !user) return <Unauthorized />;

  return (
    <NoticeContext.Provider value={{ showNotice }}>
      <UserContext.Provider value={user}>
        <div className="min-h-screen bg-[var(--color-surface-base)] text-[var(--color-text-primary)]">
          <Header route={route} onNavigate={navigate} userEmail={user.email} />

          {notice && <NoticeBar notice={notice} />}

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
      </UserContext.Provider>
    </NoticeContext.Provider>
  );
}
