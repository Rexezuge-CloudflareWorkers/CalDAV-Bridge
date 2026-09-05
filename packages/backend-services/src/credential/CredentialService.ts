import { CalDavCredentialDAO } from '@caldav-bridge/backend-data/dao';
import type { D1Queryable } from '@caldav-bridge/backend-data/utils';
import { BadRequestError, InternalServerError } from '@caldav-bridge/backend-errors';
import { ConfigurationManager } from '@caldav-bridge/backend-runtime/config';
import { CONNECTED_APPLICATION_STATUS_CONNECTED } from '@caldav-bridge/shared/constants';
import type { CalDavCredentialMetadata, ConnectedApplication } from '@caldav-bridge/shared/model';
import { CalDavCredentialUtil, TimestampUtil } from '@caldav-bridge/shared/utils';

interface CredentialServiceEnv {
  DB: D1Queryable;
}

class CredentialService {
  constructor(private readonly env: CredentialServiceEnv) {}

  public async listCredentials(applicationId: string): Promise<CalDavCredentialMetadata[]> {
    return new CalDavCredentialDAO(this.env.DB).listByApplication(applicationId);
  }

  public async createCredential(
    application: ConnectedApplication,
    name: string,
    expiresInDays?: number,
  ): Promise<{ password: string; metadata: CalDavCredentialMetadata }> {
    if (application.status !== CONNECTED_APPLICATION_STATUS_CONNECTED)
      throw new BadRequestError('Connect OAuth2 before creating CalDAV credentials.');
    const credentialDAO = new CalDavCredentialDAO(this.env.DB);
    const maxCredentials = ConfigurationManager.caldav.getMaxCredentialsPerApplication(this.env);
    if ((await credentialDAO.countByApplication(application.applicationId)) >= maxCredentials)
      throw new BadRequestError(`Maximum ${maxCredentials} CalDAV credentials allowed per application.`);
    const defaultDays = ConfigurationManager.caldav.getDefaultCredentialExpiryDays(this.env);
    const maxDays = ConfigurationManager.caldav.getMaxCredentialExpiryDays(this.env);
    const effectiveExpiresInDays = expiresInDays || defaultDays;
    if (effectiveExpiresInDays > maxDays) throw new BadRequestError(`CalDAV credential expiry cannot exceed ${maxDays} days.`);
    const password = CalDavCredentialUtil.generatePassword();
    const passwordHash = await CalDavCredentialUtil.hashPassword(password);
    const expiresAt = TimestampUtil.addDays(TimestampUtil.getCurrentUnixTimestampInSeconds(), effectiveExpiresInDays);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const username = CalDavCredentialUtil.generateUsername();
      if (await credentialDAO.usernameExists(username)) continue;
      try {
        const metadata = await credentialDAO.create(
          application.applicationId,
          username,
          passwordHash,
          name,
          CalDavCredentialUtil.getPrefix(password),
          CalDavCredentialUtil.getLastFour(password),
          expiresAt,
        );
        return { password, metadata };
      } catch (error) {
        if (!CredentialService.isUniqueConstraintError(error)) throw error;
      }
    }
    throw new InternalServerError('Failed to generate a unique CalDAV username.');
  }

  public async deleteCredential(applicationId: string, credentialId: string): Promise<void> {
    await new CalDavCredentialDAO(this.env.DB).deleteForApplication(credentialId, applicationId);
  }

  private static isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Error && /unique constraint/i.test(error.message);
  }
}

export { CredentialService };
export type { CredentialServiceEnv };
