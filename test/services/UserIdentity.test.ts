import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getByUserId, getByAnchorEmail, getByCurrentEmail, insertIfAbsent, touch, register, get } = vi.hoisted(() => ({
  getByUserId: vi.fn(),
  getByAnchorEmail: vi.fn(),
  getByCurrentEmail: vi.fn(),
  insertIfAbsent: vi.fn(),
  touch: vi.fn(),
  register: vi.fn(),
  get: vi.fn(),
}));

vi.mock('@caldav-bridge/backend-data/dao', () => ({
  UserDAO: class {
    static newAnchor = () => 'anchor-0123456789abcdef0123456789abcdef@users.invalid';
    getByUserId = getByUserId;
    getByAnchorEmail = getByAnchorEmail;
    getByCurrentEmail = getByCurrentEmail;
    insertIfAbsent = insertIfAbsent;
    touch = touch;
  },
  UserEmailDAO: class {
    register = register;
    get = get;
  },
}));

import { UserIdentityService } from '@caldav-bridge/backend-services/user';

const ALICE_ID = '11111111-1111-4111-8111-111111111111';

interface FakeAnchor {
  user_id: string;
  email: string;
  current_email: string;
  created_at: number;
}

/** Stand-in for the `users` table: anchors are unique, ids are what we mint. */
class FakeUsers {
  public readonly rows = new Map<string, FakeAnchor>();
  private counter = 0;

  /** Pre-existing row, as if written before the current test ran. */
  public seed(userId: string, anchor: string, currentEmail: string, createdAt = 100): FakeAnchor {
    const row: FakeAnchor = { user_id: userId, email: anchor, current_email: currentEmail.toLowerCase(), created_at: createdAt };
    this.rows.set(anchor, row);
    return row;
  }

  public insertIfAbsent = async (anchor: string, currentEmail: string): Promise<FakeAnchor | undefined> => {
    if (this.rows.has(anchor)) return undefined;
    this.counter += 1;
    const row: FakeAnchor = {
      user_id: `minted-${this.rows.size + 1}`,
      email: anchor,
      current_email: currentEmail.toLowerCase(),
      created_at: 200 + this.counter,
    };
    this.rows.set(anchor, row);
    return row;
  };

  public getByAnchorEmail = async (email: string): Promise<FakeAnchor | undefined> => {
    const found = [...this.rows.values()].find((row) => row.email.toLowerCase() === email.toLowerCase());
    return found;
  };

  public getByCurrentEmail = async (email: string): Promise<FakeAnchor | undefined> => {
    const found = [...this.rows.values()].find((row) => row.current_email === email.toLowerCase());
    return found;
  };

  public getByUserId = async (userId: string): Promise<FakeAnchor | undefined> => {
    return [...this.rows.values()].find((row) => row.user_id === userId);
  };
}

function verifiedRegistryRow(email: string, userId: string): { email: string; user_id: string; is_verified: number; created_at: number } {
  return { email, user_id: userId, is_verified: 1, created_at: 100 };
}

describe('UserIdentityService', () => {
  let users: FakeUsers;

  beforeEach(() => {
    vi.clearAllMocks();
    users = new FakeUsers();
    insertIfAbsent.mockImplementation(users.insertIfAbsent);
    getByAnchorEmail.mockImplementation(users.getByAnchorEmail);
    getByCurrentEmail.mockImplementation(users.getByCurrentEmail);
    getByUserId.mockImplementation(users.getByUserId);
    // No registry entry by default: either a brand-new address or a database
    // predating migration 0004.
    get.mockResolvedValue(undefined);
    register.mockResolvedValue('claimed');
    touch.mockResolvedValue(undefined);
  });

  it('resolves a verified registry row to its account', async () => {
    users.seed(ALICE_ID, 'Alice@Example.com', 'alice@example.com');
    get.mockResolvedValue(verifiedRegistryRow('alice@example.com', ALICE_ID));

    const identity = await new UserIdentityService({ DB: {} as never }).resolveOrCreate('Alice@Example.com');

    expect(identity).toEqual({ userId: ALICE_ID, currentEmail: 'alice@example.com', anchorEmail: 'Alice@Example.com' });
    expect(insertIfAbsent).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('refreshes the heartbeat so an active user is not reaped as empty', async () => {
    users.seed(ALICE_ID, 'Alice@Example.com', 'alice@example.com');
    get.mockResolvedValue(verifiedRegistryRow('alice@example.com', ALICE_ID));

    await new UserIdentityService({ DB: {} as never }).resolveOrCreate('alice@example.com');

    expect(touch).toHaveBeenCalledExactlyOnceWith(ALICE_ID);
  });

  it('creates an account anchored on the real address for a new signer', async () => {
    const identity = await new UserIdentityService({ DB: {} as never }).resolveOrCreate('New@Example.com');

    expect(insertIfAbsent).toHaveBeenCalledExactlyOnceWith('new@example.com', 'new@example.com');
    expect(identity).toEqual({ userId: 'minted-1', currentEmail: 'new@example.com', anchorEmail: 'new@example.com' });
    // Claimed with the account's own creation timestamp so a later change to a
    // new address can order the two.
    expect(register).toHaveBeenCalledExactlyOnceWith({ email: 'new@example.com', userId: 'minted-1', isVerified: true, createdAt: 201 });
  });

  it('normalizes the address so casing cannot fork an account', async () => {
    const first = await new UserIdentityService({ DB: {} as never }).resolveOrCreate('New@Example.com');
    const second = await new UserIdentityService({ DB: {} as never }).resolveOrCreate('NEW@EXAMPLE.COM');

    expect(second.userId).toBe(first.userId);
    expect(users.rows.size).toBe(1);
  });

  it('falls back to an opaque anchor so a released address stays re-claimable', async () => {
    // Alice holds `new@example.com` as her frozen anchor and then moves away, so
    // her registry row is revoked. The anchor column is immutable, so the address
    // can never become the new holder's anchor -- their applications would
    // otherwise disappear from under them.
    users.seed(ALICE_ID, 'new@example.com', 'new@example.com');
    get.mockResolvedValue({ email: 'new@example.com', user_id: ALICE_ID, is_verified: 0, created_at: 100 });

    const identity = await new UserIdentityService({ DB: {} as never }).resolveOrCreate('new@example.com');

    expect(insertIfAbsent).toHaveBeenNthCalledWith(1, 'new@example.com', 'new@example.com');
    expect(insertIfAbsent).toHaveBeenNthCalledWith(2, 'anchor-0123456789abcdef0123456789abcdef@users.invalid', 'new@example.com');
    expect(identity.anchorEmail).toBe('anchor-0123456789abcdef0123456789abcdef@users.invalid');
    expect(identity.userId).not.toBe(ALICE_ID);
    // The sign-in address is still the real one, so the UI shows it.
    expect(identity.currentEmail).toBe('new@example.com');
    // The revoked registry row is re-pointed at the new account, so the address
    // authenticates its new holder and inherits nothing.
    expect(register).toHaveBeenCalledExactlyOnceWith({
      email: 'new@example.com',
      userId: identity.userId,
      isVerified: true,
      createdAt: 201,
    });
  });

  it('never resolves a revoked address to the account that changed away from it', async () => {
    users.seed(ALICE_ID, 'Alice@Example.com', 'alice@example.com');
    get.mockResolvedValue({ email: 'alice@example.com', user_id: ALICE_ID, is_verified: 0, created_at: 100 });

    const identity = await new UserIdentityService({ DB: {} as never }).resolveOrCreate('alice@example.com');

    // The revoked registry row is authoritative: no `users` fallback is consulted,
    // so the old account -- and the applications it owns -- is unreachable.
    expect(getByCurrentEmail).not.toHaveBeenCalled();
    expect(getByAnchorEmail).not.toHaveBeenCalled();
    expect(identity.userId).not.toBe(ALICE_ID);
  });

  it('falls back to the anchor lookup on a database predating the registry', async () => {
    users.seed(ALICE_ID, 'Alice@Example.com', 'alice@example.com');
    get.mockResolvedValue(undefined);

    const identity = await new UserIdentityService({ DB: {} as never }).resolveOrCreate('Alice@Example.com');

    expect(identity.userId).toBe(ALICE_ID);
    expect(insertIfAbsent).not.toHaveBeenCalled();
  });

  it('reads current_email before the anchor so a changed address resolves to its own account', async () => {
    // Alice moves to bob@example.com. Both rows exist; the address must resolve to
    // whichever account lists it as current, never to whoever anchors on it.
    users.seed(ALICE_ID, 'Alice@Example.com', 'bob@example.com');
    get.mockResolvedValue(undefined);

    const identity = await new UserIdentityService({ DB: {} as never }).resolveOrCreate('bob@example.com');

    expect(getByCurrentEmail).toHaveBeenCalledWith('bob@example.com');
    expect(getByAnchorEmail).not.toHaveBeenCalled();
    expect(identity.userId).toBe(ALICE_ID);
  });

  it('provisions a fresh account when a registry row points at a deleted account', async () => {
    // The registry references a user_id that no longer exists. A stale row must
    // not lock its holder out, and must not silently resurrect the deleted one.
    get.mockResolvedValue(verifiedRegistryRow('alice@example.com', ALICE_ID));
    getByUserId.mockResolvedValue(undefined);

    const identity = await new UserIdentityService({ DB: {} as never }).resolveOrCreate('alice@example.com');

    expect(identity.userId).toBe('minted-1');
    expect(insertIfAbsent).toHaveBeenCalledWith('alice@example.com', 'alice@example.com');
  });

  it('reports a failure when no anchor can be created', async () => {
    // Both attempts report a taken anchor, which means the insert semantics and
    // the conflict check disagree -- a bug, not a normal condition.
    insertIfAbsent.mockResolvedValue(undefined);

    await expect(new UserIdentityService({ DB: {} as never }).resolveOrCreate('alice@example.com')).rejects.toThrow(
      /provision an account/i,
    );
    expect(register).not.toHaveBeenCalled();
  });
});
