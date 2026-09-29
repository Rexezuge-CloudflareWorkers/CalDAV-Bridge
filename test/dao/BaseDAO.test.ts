import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DatabaseError } from '@caldav-bridge/backend-errors';
import { BaseDAO } from '@caldav-bridge/backend-data/dao/BaseDAO';
import { asD1Queryable, countingD1Queryable } from '../helpers/d1';
import { applyMigrations } from '../helpers/migrations';

/** A DAO that exposes the shared plumbing directly, so it can be tested on its own. */
class ProbeDAO extends BaseDAO {
  public async readMissingTable(): Promise<unknown> {
    return this.first('SELECT * FROM a_table_that_does_not_exist');
  }

  public async readViolation(): Promise<unknown> {
    await this.run('INSERT INTO users (email, created_at, updated_at) VALUES (?, ?, ?)', ['dup@example.com', 1, 1]);
    return this.run('INSERT INTO users (email, created_at, updated_at) VALUES (?, ?, ?)', ['dup@example.com', 1, 1]);
  }

  public async readOne(bindings: unknown[]): Promise<unknown> {
    return this.first('SELECT email FROM users WHERE email = ?', bindings);
  }

  public async readAll(bindings: unknown[]): Promise<unknown[]> {
    return this.all('SELECT email FROM users WHERE email LIKE ?', bindings);
  }

  public async runBatch(statements: D1PreparedStatement[]): Promise<number> {
    await this.batch(statements);
    return statements.length;
  }
}

function openDatabase(): { database: DatabaseSync; dao: ProbeDAO } {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(database);
  return { database, dao: new ProbeDAO(asD1Queryable(database)) };
}

describe('BaseDAO', () => {
  it('returns a row, and undefined when there is none', async () => {
    const { database, dao } = openDatabase();
    database.prepare('INSERT INTO users (email, created_at, updated_at) VALUES (?, ?, ?)').run('one@example.com', 1, 1);

    await expect(dao.readOne(['one@example.com'])).resolves.toMatchObject({ email: 'one@example.com' });
    // A successful query with no match resolves to a nullish value, which is not
    // a failure and must not be reported as one.
    await expect(dao.readOne(['absent@example.com'])).resolves.toBeUndefined();
  });

  it('returns every row, and an empty list rather than undefined', async () => {
    const { database, dao } = openDatabase();
    database.prepare('INSERT INTO users (email, created_at, updated_at) VALUES (?, ?, ?)').run('a@example.com', 1, 1);

    await expect(dao.readAll(['%example.com'])).resolves.toHaveLength(1);
    await expect(dao.readAll(['%nothing%'])).resolves.toEqual([]);
  });

  /**
   * D1 reports a constraint violation through the result rather than by
   * throwing, so it has to be checked. Ignoring it is how a `UNIQUE` failure
   * arrived at a caller as an opaque 500 that the credential service then had
   * to identify by matching `/unique constraint/i` against an error message.
   */
  it('raises a DatabaseError when a statement is rejected', async () => {
    const { dao } = openDatabase();

    await expect(dao.readViolation()).rejects.toBeInstanceOf(DatabaseError);
  });

  it('raises a DatabaseError rather than reporting a missing table as no row', async () => {
    const { dao } = openDatabase();

    // Resolving to `undefined` would be indistinguishable from "no such row", so
    // a schema problem would read to the caller as an empty result.
    await expect(dao.readMissingTable()).rejects.toBeInstanceOf(DatabaseError);
  });

  it('keeps a batch atomic, so a failure leaves nothing committed', async () => {
    const { database, dao } = openDatabase();
    const db = asD1Queryable(database) as unknown as D1Queryable;

    const statements = [
      db.prepare('INSERT INTO users (email, created_at, updated_at) VALUES (?, ?, ?)').bind('first@example.com', 1, 1),
      // A duplicate of the first insert, so the batch must fail as a unit.
      db.prepare('INSERT INTO users (email, created_at, updated_at) VALUES (?, ?, ?)').bind('first@example.com', 1, 1),
    ];

    await expect(dao.runBatch(statements)).rejects.toBeInstanceOf(DatabaseError);

    // The first insert was rolled back with the second. Without the shared
    // transaction it would have been left behind.
    const remaining = database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    expect(remaining.count).toBe(0);
  });

  it('treats an empty batch as a no-op', async () => {
    const { dao } = openDatabase();

    await expect(dao.runBatch([])).resolves.toBe(0);
  });

  it('charges a batch as one subrequest however many statements it carries', async () => {
    const { database, dao: plainDAO } = openDatabase();
    const counting = countingD1Queryable(database);
    const dao = new ProbeDAO(counting.database);
    const db = counting.database;
    database.prepare('INSERT INTO users (email, created_at, updated_at) VALUES (?, ?, ?)').run('one@example.com', 1, 1);

    const statements = Array.from({ length: 50 }, (_, index) =>
      db.prepare('INSERT INTO users (email, created_at, updated_at) VALUES (?, ?, ?)').bind(`batch-${index}@example.com`, 1, 1),
    );

    const before = counting.subrequests();
    await dao.runBatch(statements);

    expect(counting.subrequests() - before).toBe(1);
    expect(plainDAO).toBeDefined();
  });
});
