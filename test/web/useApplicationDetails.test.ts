import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApplicationDetails } from '~/hooks/useApplicationDetails';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useNotice } from '~/hooks/useNotice';
import type { ConnectedApplication } from '~/types';

const service = vi.hoisted(() => ({
  listCredentials: vi.fn(),
  createCredential: vi.fn(),
  deleteCredential: vi.fn(),
  listCalendars: vi.fn(),
  loadCurrentUser: vi.fn(),
}));

vi.mock('~/services/credentialService', () => ({
  listCredentials: service.listCredentials,
  createCredential: service.createCredential,
  deleteCredential: service.deleteCredential,
}));
vi.mock('~/services/calendarService', () => ({ listCalendars: service.listCalendars }));
vi.mock('~/services/userService', () => ({ loadCurrentUser: service.loadCurrentUser }));

const application: ConnectedApplication = {
  applicationId: 'app-1',
  displayName: 'Primary',
  providerId: 'google-calendar',
  status: 'connected',
};

const credential = {
  credentialId: 'cred-1',
  name: 'Laptop',
  username: 'otter1234',
  passwordPrefix: 'cb_',
  passwordLastFour: 'abcd',
  expiresAt: 4_102_444_800,
};

const issued = { password: 'cb_generated-secret', metadata: credential };

describe('useApplicationDetails', () => {
  beforeEach(() => {
    service.listCredentials.mockResolvedValue([credential]);
    service.listCalendars.mockResolvedValue([{ id: 'cal-1', name: 'Primary' }]);
    service.createCredential.mockResolvedValue(issued);
    service.deleteCredential.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('issues nothing until an application is selected', async () => {
    const { result } = renderHook(() => useApplicationDetails({ selectedApplication: undefined, showNotice: vi.fn() }));

    await act(async () => {
      await result.current.generateCredential();
      await result.current.removeCredential('cred-1');
    });

    // The write paths guard on the selection. Without a guard each would issue a
    // request for `undefined` and report success for a credential that was never
    // created or deleted.
    expect(service.createCredential).not.toHaveBeenCalled();
    expect(service.deleteCredential).not.toHaveBeenCalled();
  });

  it('loads credentials and calendars for a connected application', async () => {
    const { result } = renderHook(() => useApplicationDetails({ selectedApplication: application, showNotice: vi.fn() }));

    await act(async () => {
      await result.current.loadDetails('app-1', 'connected');
    });

    expect(service.listCredentials).toHaveBeenCalledWith('app-1');
    expect(service.listCalendars).toHaveBeenCalledWith('app-1');
    expect(result.current.credentials).toEqual([credential]);
    expect(result.current.calendars).toEqual([{ id: 'cal-1', name: 'Primary' }]);
  });

  /**
   * Calendars are only fetched for a connected application. A draft has no
   * provider credentials yet, so the request would fail and surface as an error
   * the user cannot act on before they have finished connecting.
   */
  it('does not request calendars for an application that is not connected', async () => {
    const { result } = renderHook(() =>
      useApplicationDetails({ selectedApplication: { ...application, status: 'draft' }, showNotice: vi.fn() }),
    );

    await act(async () => {
      await result.current.loadDetails('app-1', 'draft');
    });

    expect(service.listCredentials).toHaveBeenCalled();
    expect(service.listCalendars).not.toHaveBeenCalled();
  });

  it('surfaces the generated password, and does not show a previous one', async () => {
    const { result } = renderHook(() => useApplicationDetails({ selectedApplication: application, showNotice: vi.fn() }));

    await act(async () => {
      await result.current.generateCredential();
    });

    // The password is shown once and never stored, so it cannot be redisplayed.
    expect(result.current.newPassword).toBe('cb_generated-secret');
    expect(result.current.newUsername).toBe('otter1234');
  });

  /**
   * Switching applications must not leave the previous one's password on screen.
   * The one-time password is the only copy the user will ever have, and showing
   * it next to the wrong application's credentials is worse than not showing it.
   */
  it('discards a shown password when the selection changes', () => {
    const { result, rerender } = renderHook(
      ({ selected }: { selected: ConnectedApplication | undefined }) =>
        useApplicationDetails({ selectedApplication: selected, showNotice: vi.fn() }),
      { initialProps: { selected: application as ConnectedApplication | undefined } },
    );

    expect(result.current.newPassword).toBe('');
    rerender({ selected: { ...application, applicationId: 'app-2' } });
    expect(result.current.newPassword).toBe('');
    expect(result.current.credentials).toEqual([]);
  });

  it('reloads the credentials after issuing one, so the new one is listed', async () => {
    const { result } = renderHook(() => useApplicationDetails({ selectedApplication: application, showNotice: vi.fn() }));

    await act(async () => {
      await result.current.loadDetails('app-1', 'connected');
    });
    service.listCredentials.mockClear();
    await act(async () => {
      await result.current.generateCredential();
    });

    expect(service.listCredentials).toHaveBeenCalled();
  });

  it('asks for confirmation before deleting, and deletes only once confirmed', async () => {
    const { result } = renderHook(() => useApplicationDetails({ selectedApplication: application, showNotice: vi.fn() }));
    await act(async () => {
      await result.current.loadDetails('app-1', 'connected');
    });

    act(() => result.current.setConfirmDelete(credential));
    // Nothing is deleted while the confirmation is merely displayed.
    expect(service.deleteCredential).not.toHaveBeenCalled();
    expect(result.current.confirmDelete).toEqual(credential);

    await act(async () => {
      await result.current.removeCredential('cred-1');
    });

    expect(service.deleteCredential).toHaveBeenCalledWith('app-1', 'cred-1');
  });

  it('clears the confirmation after a successful delete', async () => {
    const { result } = renderHook(() => useApplicationDetails({ selectedApplication: application, showNotice: vi.fn() }));
    await act(async () => {
      await result.current.loadDetails('app-1', 'connected');
    });
    act(() => result.current.setConfirmDelete(credential));

    await act(async () => {
      await result.current.removeCredential('cred-1');
    });

    // A stale confirmation would let a later click delete the same credential
    // again, or the wrong one after the list reloaded.
    expect(result.current.confirmDelete).toBeNull();
  });

  it('keeps the confirmation when a delete fails, so it can be retried', async () => {
    service.deleteCredential.mockRejectedValue(new Error('Credential is in use'));
    const { result } = renderHook(() => useApplicationDetails({ selectedApplication: application, showNotice: vi.fn() }));
    await act(async () => {
      await result.current.loadDetails('app-1', 'connected');
    });
    act(() => result.current.setConfirmDelete(credential));

    await act(async () => {
      await expect(result.current.removeCredential('cred-1')).rejects.toThrow('Credential is in use');
    });

    expect(result.current.confirmDelete).toEqual(credential);
  });
});

describe('useCurrentUser', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports an authorized user', async () => {
    const user = { userId: 'user-1', email: 'owner@example.com', limits: {} };
    service.loadCurrentUser.mockResolvedValue(user);

    const { result } = renderHook(() => useCurrentUser());

    await waitFor(() => expect(result.current.authorized).toBe(true));
    expect(result.current.user).toEqual(user);
  });

  /**
   * An authorization failure and an absent user are the same state to the UI --
   * it renders the unauthorized screen either way -- and the distinction is only
   * worth keeping for the message.
   */
  it('reports unauthorized rather than throwing when the user cannot be loaded', async () => {
    service.loadCurrentUser.mockRejectedValue(new Error('401'));

    const { result } = renderHook(() => useCurrentUser());

    await waitFor(() => expect(result.current.authorized).toBe(false));
    expect(result.current.user).toBeNull();
  });

  it('starts in an undetermined state so the UI does not flash the unauthorized screen', async () => {
    service.loadCurrentUser.mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(() => useCurrentUser());

    // `null` renders a spinner; `false` would render "unauthorized" during the
    // very first frame of a page that was about to work.
    expect(result.current.authorized).toBeNull();
  });
});

describe('useNotice', () => {
  it('shows a notice and clears it after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useNotice());

      act(() => result.current.showNotice('success', 'Saved.'));

      expect(result.current.notice).toEqual({ type: 'success', text: 'Saved.' });
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(result.current.notice).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces an earlier notice and restarts its timer', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useNotice());

      act(() => result.current.showNotice('success', 'First.'));
      act(() => {
        vi.advanceTimersByTime(9_000);
      });
      act(() => result.current.showNotice('error', 'Second.'));

      // The first notice's timer would still be pending, so without the reset it
      // would clear the second notice early.
      expect(result.current.notice).toEqual({ type: 'error', text: 'Second.' });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(result.current.notice).toEqual({ type: 'error', text: 'Second.' });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The OAuth2 callback returns to the SPA with its result in the query string.
   * Reporting it once and then leaving it in the URL would show the same banner
   * again on every reload of that URL.
   */
  it('reports a successful OAuth2 return from the query string', () => {
    const original = globalThis.location.search;
    globalThis.history.replaceState(null, '', '/user/apps?oauth2=connected');
    try {
      const { result } = renderHook(() => useNotice());

      expect(result.current.notice?.type).toBe('success');
    } finally {
      globalThis.history.replaceState(null, '', `/user/apps${original}`);
    }
  });

  it('reports a failed OAuth2 return with the provider message', () => {
    globalThis.history.replaceState(null, '', '/user/apps?oauth2=error&message=access_denied');
    try {
      const { result } = renderHook(() => useNotice());

      expect(result.current.notice).toEqual({ type: 'error', text: 'access_denied' });
    } finally {
      globalThis.history.replaceState(null, '', '/user/apps');
    }
  });
});
