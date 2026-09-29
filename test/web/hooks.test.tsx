import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApplications } from '~/hooks/useApplications';
import { useRouting } from '~/hooks/useRouting';
import { parseRoute, routePath } from '~/types';

const service = vi.hoisted(() => ({
  listApplications: vi.fn(),
  createApplication: vi.fn(),
  loadCurrentUser: vi.fn(),
  listCalendars: vi.fn(),
  listCredentials: vi.fn(),
}));

vi.mock('~/services/applicationService', () => ({
  listApplications: service.listApplications,
  createApplication: service.createApplication,
}));

vi.mock('~/services/userService', () => ({ loadCurrentUser: service.loadCurrentUser }));
vi.mock('~/services/calendarService', () => ({ listCalendars: service.listCalendars }));
vi.mock('~/services/credentialService', () => ({
  listCredentials: service.listCredentials,
  createCredential: vi.fn(),
  deleteCredential: vi.fn(),
}));

const application = { applicationId: 'app-1', displayName: 'Primary', providerId: 'google-calendar', status: 'connected' } as const;

describe('useRouting', () => {
  beforeEach(() => {
    globalThis.history.replaceState(null, '', '/user/apps');
  });

  it('reads the initial route from the location', () => {
    const { result } = renderHook(() => useRouting());

    expect(result.current.route).toEqual({ page: 'applications' });
  });

  it('navigates by pushing a history entry and updating the route', () => {
    const { result } = renderHook(() => useRouting());

    act(() => result.current.navigate({ page: 'connect' }));

    expect(result.current.route).toEqual({ page: 'connect' });
    expect(globalThis.location.pathname).toBe('/user/connect');
  });

  it('replaces rather than pushing, for a redirect that should not be backable', () => {
    const { result } = renderHook(() => useRouting());
    const historyLengthBefore = globalThis.history.length;

    act(() => result.current.replaceRoute({ page: 'details', applicationId: 'app-1' }));

    expect(globalThis.location.pathname).toBe('/user/apps/app-1');
    expect(globalThis.history.length).toBe(historyLengthBefore);
  });

  it('follows a browser back navigation', async () => {
    const { result } = renderHook(() => useRouting());
    act(() => result.current.navigate({ page: 'connect' }));

    // The listener is registered on mount; a popstate is the only way a client
    // navigates without this hook being told to.
    await act(async () => {
      globalThis.history.replaceState(null, '', '/user/apps');
      globalThis.dispatchEvent(new PopStateEvent('popstate'));
    });

    await waitFor(() => expect(result.current.route).toEqual({ page: 'applications' }));
  });

  it('unregisters its listener on unmount', () => {
    const removeEventListener = vi.spyOn(globalThis, 'removeEventListener');
    const { unmount } = renderHook(() => useRouting());

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith('popstate', expect.any(Function));
    removeEventListener.mockRestore();
  });
});

describe('route parsing', () => {
  it('round-trips every route it can parse', () => {
    for (const route of [
      { page: 'applications' } as const,
      { page: 'connect' } as const,
      { page: 'details', applicationId: 'app-1' } as const,
    ]) {
      expect(parseRoute(routePath(route))).toEqual(route);
    }
  });

  it('decodes an application id containing a slash', () => {
    // A nested id must survive the round trip, or the details view would look
    // up an id that was truncated at the slash.
    expect(parseRoute('/user/apps/nested%2Fid')).toEqual({ page: 'details', applicationId: 'nested/id' });
    expect(routePath({ page: 'details', applicationId: 'nested/id' })).toBe('/user/apps/nested%2Fid');
  });

  it('falls back to the applications view for an unknown path', () => {
    expect(parseRoute('/user/nonsense')).toEqual({ page: 'applications' });
    expect(parseRoute('/')).toEqual({ page: 'applications' });
  });

  it('tolerates a trailing slash', () => {
    expect(parseRoute('/user/connect/')).toEqual({ page: 'connect' });
  });
});

describe('useApplications', () => {
  beforeEach(() => {
    service.listApplications.mockResolvedValue([application]);
    service.createApplication.mockResolvedValue(application);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads the list and reports success through the notice callback', async () => {
    const showNotice = vi.fn();
    const { result } = renderHook(() => useApplications({ showNotice }));

    await act(async () => {
      await result.current.loadApplications();
    });

    expect(result.current.applications).toEqual([application]);
    expect(service.listApplications).toHaveBeenCalledOnce();
  });

  it('surfaces a load failure to the caller rather than swallowing it', async () => {
    service.listApplications.mockRejectedValue(new Error('Network unreachable'));
    const showNotice = vi.fn();
    const { result } = renderHook(() => useApplications({ showNotice }));

    // The caller decides how to report it; the hook must not turn a failure into
    // an empty list, which would render as "you have no applications".
    await expect(result.current.loadApplications()).rejects.toThrow('Network unreachable');
  });

  it('clears the form fields after a successful create', async () => {
    const showNotice = vi.fn();
    const { result } = renderHook(() => useApplications({ showNotice }));

    await act(async () => {
      result.current.setDisplayName('Primary');
      result.current.setClientId('client-id');
      result.current.setClientSecret('client-secret');
    });
    await act(async () => {
      await result.current.saveApplication();
    });

    // Leaving the client secret in the field would put a credential in a DOM
    // node that stays on screen after it has been saved.
    expect(result.current.displayName).toBe('');
    expect(result.current.clientId).toBe('');
    expect(result.current.clientSecret).toBe('');
    expect(showNotice).toHaveBeenCalledWith('success', expect.any(String));
  });

  it('reloads the list after a create, so the new application is present', async () => {
    const showNotice = vi.fn();
    const { result } = renderHook(() => useApplications({ showNotice }));

    await act(async () => {
      await result.current.saveApplication();
    });

    expect(service.listApplications).toHaveBeenCalled();
  });

  it('keeps the form fields when a create fails', async () => {
    service.createApplication.mockRejectedValue(new Error('Duplicate name'));
    const showNotice = vi.fn();
    const { result } = renderHook(() => useApplications({ showNotice }));

    await act(async () => {
      result.current.setDisplayName('Primary');
    });
    await act(async () => {
      await expect(result.current.saveApplication()).rejects.toThrow('Duplicate name');
    });

    // Clearing on failure would discard what the user typed for no reason.
    expect(result.current.displayName).toBe('Primary');
  });
});
