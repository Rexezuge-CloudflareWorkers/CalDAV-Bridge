import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { BaseDAO, decryptSecret, encryptSecret } from '@rexezuge/d1';
import { EncryptedDAO } from '@caldav-bridge/backend-data/dao';
import { asD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

// The kit's aes-gcm contract: base64 of exactly 32 bytes.
const MASTER_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

/**
 * A DAO whose rows carry a value encrypted with the app's master key.
 *
 * This is the class the pilot kept local when CalDAV's `BaseDAO.ts` moved to
 * the kit — the old file carried both, and only the base belonged upstream.
 * The credential DAOs it serves are covered in `ConnectedApplicationDAO.test.ts`
 * with the full fixture; what is pinned here is the class's own contract:
 * the key is injected (never read from the environment), and the sql-first
 * read surface is inherited from the kit rather than reimplemented.
 */
class SealedDAO extends EncryptedDAO {
  public constructor(database: ConstructorParameters<typeof EncryptedDAO>[0]) {
    super(database, MASTER_KEY);
  }

  /** The key as the base received it, read from inside the subclass. */
  public get injectedKey(): string {
    return this.masterKey;
  }

  /** Seal a value exactly as a credential DAO does, through the base. */
  public async seal(value: string): Promise<{ ciphertext: string; iv: string }> {
    return encryptSecret(value, this.masterKey);
  }

  /** Read one row through the kit's `first`, so the inherited surface is exercised. */
  public async readRow(email: string): Promise<{ email: string } | undefined> {
    return this.first<{ email: string }>('SELECT email FROM users WHERE email = ? LIMIT 1', [email]);
  }
}

describe('EncryptedDAO', () => {
  it('never reads the master key from the environment — it is injected once, per DAO', () => {
    // The key is a constructor argument, not an env read: a DAO that reached
    // for the environment itself could not be tested without a real secret,
    // and two DAOs in one test could not be given different keys.
    const dao = new SealedDAO(openDatabase());
    expect(dao.injectedKey).toBe(MASTER_KEY);
  });

  it('seals through the kit envelope: a fresh IV per value, read back by key', async () => {
    const dao = new SealedDAO(openDatabase());

    const first = await dao.seal('client-secret-value');
    const second = await dao.seal('client-secret-value');

    expect(first.ciphertext).not.toContain('client-secret');
    // A reused IV under one key is the failure GCM exists to prevent, so two
    // seals of the same plaintext must not agree on either half.
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);

    await expect(decryptSecret(first, MASTER_KEY)).resolves.toBe('client-secret-value');
    await expect(decryptSecret(first, 'AAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')).rejects.toThrow();
  });

  it('is a BaseDAO: the sql-first read surface is inherited, not reimplemented', async () => {
    const dao = new SealedDAO(openDatabase());
    expect(dao).toBeInstanceOf(BaseDAO);
    expect(await dao.readRow('absent@example.test')).toBeUndefined();
  });
});

function openDatabase(): ReturnType<typeof asD1Queryable> {
  const database = new DatabaseSync(':memory:');
  applyMigrations(database);
  return asD1Queryable(database);
}