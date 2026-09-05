import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestError, InternalServerError } from '@caldav-bridge/backend-errors';

const { credentialSpies } = vi.hoisted(() => ({
  credentialSpies: {
    listByApplication: vi.fn(),
    countByApplication: vi.fn(),
    usernameExists: vi.fn(),
    create: vi.fn(),
    deleteForApplication: vi.fn(),
  },
}));

vi.mock('@caldav-bridge/backend-data/dao', () => ({
  CalDavCredentialDAO: class {
    listByApplication = credentialSpies.listByApplication;
    countByApplication = credentialSpies.countByApplication;
    usernameExists = credentialSpies.usernameExists;
    create = credentialSpies.create;
    deleteForApplication = credentialSpies.deleteForApplication;
  },
}));

import { CredentialService } from '@caldav-bridge/backend-services/credential';
import type { CredentialServiceEnv } from '@caldav-bridge/backend-services/credential';

function testEnv(): CredentialServiceEnv {
  return { DB: {} } as unknown as CredentialServiceEnv;
}

function connectedApplication(): Record<string, unknown> {
  return { applicationId: 'app-1', status: 'connected' };
}

describe('CredentialService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires an OAuth2 connection before creating credentials', async () => {
    await expect(
      new CredentialService(testEnv()).createCredential({ ...connectedApplication(), status: 'draft' } as never, 'Laptop'),
    ).rejects.toThrow('Connect OAuth2 before creating CalDAV credentials.');
    expect(credentialSpies.countByApplication).not.toHaveBeenCalled();
  });

  it('enforces credential limits and expiry ceilings', async () => {
    credentialSpies.countByApplication.mockResolvedValue(5);

    await expect(new CredentialService(testEnv()).createCredential(connectedApplication() as never, 'Laptop')).rejects.toBeInstanceOf(
      BadRequestError,
    );

    credentialSpies.countByApplication.mockResolvedValue(0);
    await expect(
      new CredentialService(testEnv()).createCredential(connectedApplication() as never, 'Laptop', 9999),
    ).rejects.toThrow('CalDAV credential expiry cannot exceed 365 days.');
  });

  it('creates credentials with generated passwords and metadata', async () => {
    credentialSpies.countByApplication.mockResolvedValue(0);
    credentialSpies.usernameExists.mockResolvedValue(false);
    credentialSpies.create.mockImplementation(
      async (_applicationId: string, username: string, _hash: string, name: string, prefix: string, lastFour: string, expiresAt: number) => ({
        credentialId: 'cred-1',
        applicationId: 'app-1',
        username,
        name,
        passwordPrefix: prefix,
        passwordLastFour: lastFour,
        expiresAt,
      }),
    );

    const { password, metadata } = await new CredentialService(testEnv()).createCredential(connectedApplication() as never, 'Laptop');

    expect(typeof password).toBe('string');
    expect(password.length).toBeGreaterThan(0);
    expect(metadata).toMatchObject({ credentialId: 'cred-1', name: 'Laptop' });
    expect(credentialSpies.create).toHaveBeenCalledOnce();
  });

  it('retries colliding usernames and surfaces exhaustion', async () => {
    credentialSpies.countByApplication.mockResolvedValue(0);
    credentialSpies.usernameExists.mockResolvedValue(false);
    credentialSpies.create.mockRejectedValue(new Error('UNIQUE constraint failed: caldav_credentials.username'));

    await expect(new CredentialService(testEnv()).createCredential(connectedApplication() as never, 'Laptop')).rejects.toBeInstanceOf(
      InternalServerError,
    );
    expect(credentialSpies.create).toHaveBeenCalledTimes(5);
  });

  it('lists and deletes credentials by application', async () => {
    credentialSpies.listByApplication.mockResolvedValue([{ credentialId: 'cred-1' }]);
    credentialSpies.deleteForApplication.mockResolvedValue(undefined);
    const service = new CredentialService(testEnv());

    await expect(service.listCredentials('app-1')).resolves.toEqual([{ credentialId: 'cred-1' }]);
    await service.deleteCredential('app-1', 'cred-1');
    expect(credentialSpies.deleteForApplication).toHaveBeenCalledWith('cred-1', 'app-1');
  });
});
