import { UserIdentityService } from '@rexezuge/identity';
import type { ResolvedAccount } from '@rexezuge/identity';
import type { D1Queryable } from '@rexezuge/d1';
import { InternalServerError } from '@rexezuge/errors';
import { UserDAO } from '@caldav-bridge/backend-data/dao';
import { ConfigurationManager } from '@caldav-bridge/backend-runtime/config';

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
   * Returns the account rather than nothing because the caller needs the id to
   * authorize against: everything the account owns is keyed on it, so an
   * address change no longer costs the user their applications.
   *
   * Resolution itself is the kit's (`@rexezuge/identity`): a registered address
   * is authoritative, a revoked one re-registers as a fresh account rather than
   * falling through to its frozen anchor, and a first-time address is
   * provisioned with the address itself as anchor where it is free. Only the
   * heartbeat is ours -- the kit never writes `updated_at` on a resolve, and
   * the retention sweep reads it.
   */
  public async upsertUser(email: string): Promise<ResolvedAccount> {
    const account = await new UserIdentityService({ DB: this.env.DB }).resolveOrRegister(email);
    // `null` means the registry says this address belongs to an account that
    // cannot be materialized (or that neither anchor could be created). There
    // is no identity to authorize with, and answering with one that owns
    // nothing would look like success.
    if (!account) throw new InternalServerError('Failed to provision an account for the supplied email address.');
    await new UserDAO(this.env.DB).touch(account.id);
    return account;
  }

  public async getCurrentUser(account: ResolvedAccount): Promise<CurrentUser> {
    return {
      userId: account.id,
      // Always the account's current address, so the UI follows a change without
      // anything having to invalidate a session.
      email: account.email,
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
