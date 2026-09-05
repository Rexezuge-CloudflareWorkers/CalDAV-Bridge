import { UserDAO } from '@caldav-bridge/backend-data/dao';
import type { D1Queryable } from '@caldav-bridge/backend-data/utils';
import { ConfigurationManager } from '@caldav-bridge/backend-runtime/config';

interface UserServiceEnv {
  DB: D1Queryable;
}

interface CurrentUserLimits {
  maxApplicationsPerUser: number;
  maxCalDavCredentialsPerApplication: number;
  defaultCalDavCredentialExpiryDays: number;
}

class UserService {
  constructor(private readonly env: UserServiceEnv) {}

  public async upsertUser(email: string): Promise<void> {
    await new UserDAO(this.env.DB).ensure(email);
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
export type { CurrentUserLimits, UserServiceEnv };
