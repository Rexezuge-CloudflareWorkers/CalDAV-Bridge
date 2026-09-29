import { UserDAO, UserEmailDAO } from '@caldav-bridge/backend-data/dao';
import type { D1Queryable } from '@caldav-bridge/backend-data/utils';
import { InternalServerError } from '@caldav-bridge/backend-errors';

interface UserIdentityEnv {
  DB: D1Queryable;
}

interface UserIdentity {
  /** Stable account key. This is what everything downstream keys on. */
  userId: string;
  /** The address the account currently signs in with. */
  currentEmail: string;
  /**
   * The frozen anchor address. Exposed for diagnostics only -- never an identity
   * key, and it may be an opaque `...@users.invalid` placeholder.
   */
  anchorEmail: string;
}

type Resolution =
  /** The address identifies an account. */
  | { kind: 'found'; identity: UserIdentity }
  /** No account holds this address for sign-in. Provision one. */
  | { kind: 'unknown' };

/**
 * Maps an email address onto an account (migration 0004).
 *
 * Before this, an address *was* the account: `users.email` was the primary key
 * and `connected_applications.user_email` a live cascading foreign key to it, so
 * the address could not be changed without either tripping the constraint or
 * destroying the account's connected applications. Now `users.user_id` is the
 * identity, `users.current_email` is the sign-in address, and `users.email` is a
 * frozen anchor kept only so the legacy foreign key keeps resolving.
 */
class UserIdentityService {
  constructor(private readonly env: UserIdentityEnv) {}

  /**
   * Resolve a sign-in address to an account, creating one if the address is new.
   *
   * This is the only place an address is turned into an identity, so it is also
   * the only place that has to distinguish "the address someone types" from "the
   * address an account was created with".
   */
  public async resolveOrCreate(email: string): Promise<UserIdentity> {
    const normalized = email.toLowerCase();
    const resolved = await this.resolve(normalized);
    if (resolved.kind === 'found') {
      await new UserDAO(this.env.DB).touch(resolved.identity.userId);
      return resolved.identity;
    }
    // Unknown or released. Prefer the address as the frozen anchor, which is what
    // every row written before 0004 looks like. Fall back to an opaque anchor when
    // the address is already held as another account's anchor, so a released
    // address stays re-claimable by the next person who holds it.
    const created = (await this.create(normalized, normalized)) ?? (await this.create(UserDAO.newAnchor(), normalized));
    if (!created) throw new InternalServerError('Failed to provision an account for the supplied email address.');
    return created;
  }

  /**
   * Address resolution, without creating anything.
   *
   * A registered address is authoritative. A *revoked* one resolves to nobody --
   * deliberately reported as a miss, but with the legacy anchor fallback skipped.
   * That distinction is the whole point: letting a revoked address fall through to
   * the anchor lookup would hand the previous holder's applications to whoever
   * presents the address next, while reporting it as a miss lets the genuinely new
   * holder of that address (as attested by Cloudflare Access) claim it fresh,
   * re-pointing the revoked registry row rather than inheriting anything.
   */
  private async resolve(email: string): Promise<Resolution> {
    const registered = await new UserEmailDAO(this.env.DB).get(email).catch(() => undefined);
    if (registered) {
      if (registered.is_verified !== 1) return { kind: 'unknown' };
      const row = await new UserDAO(this.env.DB).getByUserId(registered.user_id).catch(() => undefined);
      if (!row?.user_id) return { kind: 'unknown' };
      return { kind: 'found', identity: UserIdentityService.toIdentity(row) };
    }
    // No registry row. Migration 0004 backfilled a verified row for every anchor,
    // so a row-less address is either brand new or on a database predating 0004
    // where the address *is* the anchor; both are covered by the `users` lookups.
    // A revoked address always has a registry row and returned above.
    const userDAO = new UserDAO(this.env.DB);
    const byCurrentEmail = await userDAO.getByCurrentEmail(email).catch(() => undefined);
    const legacy = byCurrentEmail ?? (await userDAO.getByAnchorEmail(email).catch(() => undefined));
    if (!legacy?.user_id) return { kind: 'unknown' };
    return { kind: 'found', identity: UserIdentityService.toIdentity(legacy) };
  }

  private async create(anchor: string, currentEmail: string): Promise<UserIdentity | undefined> {
    // `insertIfAbsent` only reports a row it actually created. Reading the anchor
    // back instead would return the *previous* holder's account when the anchor is
    // taken, and the registry claim below would then point the address at their
    // applications -- handing a released address to a stranger's sign-in.
    const row = await new UserDAO(this.env.DB).insertIfAbsent(anchor, currentEmail);
    if (!row?.user_id) return undefined;

    // Claim the sign-in address before returning, otherwise the fresh account is
    // invisible to the registry and the next sign-in would mint a second one.
    // `register` re-points a revoked row rather than failing, which is what makes
    // a released address re-claimable.
    await new UserEmailDAO(this.env.DB).register({
      email: currentEmail,
      userId: row.user_id,
      isVerified: true,
      createdAt: row.created_at,
    });
    return UserIdentityService.toIdentity(row);
  }

  private static toIdentity(row: {
    user_id?: string | null | undefined;
    email: string;
    current_email?: string | null | undefined;
  }): UserIdentity {
    const userId = row.user_id;
    if (!userId) throw new InternalServerError('User row is missing its user_id.');
    return { userId, currentEmail: (row.current_email ?? row.email).toLowerCase(), anchorEmail: row.email };
  }
}

export { UserIdentityService };
export type { UserIdentity, UserIdentityEnv };
