import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestError, NotFoundError } from '@caldav-bridge/backend-errors';

const { applicationSpies, credentialSpies } = vi.hoisted(() => ({
  applicationSpies: {
    listMetadataByUserEmail: vi.fn(),
    countByUserEmail: vi.fn(),
    create: vi.fn(),
    updateForUser: vi.fn(),
    deleteForUser: vi.fn(),
    getByIdForUser: vi.fn(),
  },
  credentialSpies: {
    countByApplication: vi.fn(),
  },
}));

vi.mock('@caldav-bridge/backend-data/dao', () => ({
  ConnectedApplicationDAO: class {
    constructor(
      public readonly database: unknown,
      public readonly masterKey: unknown,
    ) {}
    listMetadataByUserEmail = applicationSpies.listMetadataByUserEmail;
    countByUserEmail = applicationSpies.countByUserEmail;
    create = applicationSpies.create;
    updateForUser = applicationSpies.updateForUser;
    deleteForUser = applicationSpies.deleteForUser;
    getByIdForUser = applicationSpies.getByIdForUser;
  },
  CalDavCredentialDAO: class {
    countByApplication = credentialSpies.countByApplication;
  },
}));

import { ApplicationService } from '@caldav-bridge/backend-services/application';
import type { ApplicationServiceEnv } from '@caldav-bridge/backend-services/application';

const BASE_URL = 'https://bridge.example.test';

function testEnv(overrides: Record<string, string> = {}): ApplicationServiceEnv {
  return {
    DB: {},
    AES_ENCRYPTION_KEY_SECRET: { get: async () => 'master-key' },
    ...overrides,
  } as unknown as ApplicationServiceEnv;
}

function metadata(applicationId = 'app-1'): Record<string, unknown> {
  return {
    applicationId,
    userEmail: 'user@example.test',
    providerEmail: null,
    displayName: 'Work',
    providerId: 'google-calendar',
    connectionMethod: 'oauth2',
    status: 'draft',
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('ApplicationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists applications decorated with OAuth and CalDAV URLs', async () => {
    applicationSpies.listMetadataByUserEmail.mockResolvedValue([metadata()]);
    credentialSpies.countByApplication.mockResolvedValue(2);

    const applications = await new ApplicationService(testEnv()).listApplications('user@example.test', BASE_URL);

    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({
      oauth2RedirectUri: `${BASE_URL}/api/oauth2/callback/app-1`,
      caldavBaseUrl: `${BASE_URL}/dav/calendars/app-1/`,
      credentialCount: 2,
    });
  });

  it('enforces the per-user application limit', async () => {
    applicationSpies.countByUserEmail.mockResolvedValue(1);

    await expect(
      new ApplicationService(testEnv({ MAX_APPLICATIONS_PER_USER: '1' })).createApplication('user@example.test', {
        displayName: 'Extra',
        providerId: 'google-calendar',
        clientId: 'id',
        clientSecret: 'secret',
      }, BASE_URL),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(applicationSpies.create).not.toHaveBeenCalled();
  });

  it('creates applications below the limit', async () => {
    applicationSpies.countByUserEmail.mockResolvedValue(0);
    applicationSpies.create.mockResolvedValue(metadata('app-2'));
    credentialSpies.countByApplication.mockResolvedValue(0);

    const application = await new ApplicationService(testEnv()).createApplication('user@example.test', {
      displayName: 'Work',
      providerId: 'google-calendar',
      clientId: 'id',
      clientSecret: 'secret',
    }, BASE_URL);

    expect(applicationSpies.create).toHaveBeenCalledWith('user@example.test', 'Work', 'google-calendar', {
      clientId: 'id',
      clientSecret: 'secret',
    });
    expect(application).toMatchObject({ applicationId: 'app-2', credentialCount: 0 });
  });

  it('reports missing applications on update and lookup', async () => {
    applicationSpies.updateForUser.mockResolvedValue(undefined);
    applicationSpies.getByIdForUser.mockResolvedValue(undefined);
    const service = new ApplicationService(testEnv());

    await expect(
      service.updateApplication('user@example.test', 'missing', { displayName: 'x', providerId: 'google-calendar', clientId: 'i', clientSecret: 's' }, BASE_URL),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.requireUserApplication('user@example.test', 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes applications for the owning user', async () => {
    applicationSpies.deleteForUser.mockResolvedValue(undefined);

    await new ApplicationService(testEnv()).deleteApplication('user@example.test', 'app-1');

    expect(applicationSpies.deleteForUser).toHaveBeenCalledWith('app-1', 'user@example.test');
  });
});
