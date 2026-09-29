import type { D1Queryable } from '@caldav-bridge/backend-data/utils';
import { ConfigurationManager } from '@caldav-bridge/backend-runtime/config';
import { UserIdentityService } from './UserIdentityService';
import type { UserIdentity } from './UserIdentityService';

interface UserServiceEnv {
  DB: D1Queryable;
}

interface CurrentUserLimits {
  maxApplicationsPerUser: number;
  maxCalDavCredentialsPerApplication: number;
  defaultCalDavCredentialExpiryDays: number;
}

interface CurrentUser {
  userId: string;
  email: string;
  limits: CurrentUserLimits;
}

class UserService {
  constructor(private readonly env: UserServiceEnv) {}

  /**
   * Resolve the authenticated address to an account, creating one if needed.
   *
   * Returns the identity rather than nothing because the caller needs the account
   * id to authorize against: everything the account owns is keyed on it, so an
   * address change no longer costs the user their applications.
   */
  public async upsertUser(email: string): Promise<UserIdentity> {
    return new UserIdentityService({ DB: this.env.DB }).resolveOrCreate(email);
  }

  public async getCurrentUser(identity: UserIdentity): Promise<CurrentUser> {
    return {
      userId: identity.userId,
      // Always the account's current address, so the UI follows a change without
      // anything having to invalidate a session.
      email: identity.currentEmail,
      limits: await this.getCurrentUserLimits(),
    };
  }

  public async getCurrentUserLimits(): Promise<CurrentUserLimits> {
    return {
      maxApplicationsPerUser: ConfigurationManager.limits.getMaxApplicationsPerUser(this.env),
      maxCalDavCredentialsPerApplication: ConfigurationManager.caldav.getMaxCredentialsPerApplication(this.env),
      defaultCalDavCredentialExpiryDays: ConfigurationManager.caldav.getDefaultCredentialExpiryDays(this.env),
    };
  }
}

export { UserService };
export type { CurrentUser, CurrentUserLimits, UserServiceEnv };
