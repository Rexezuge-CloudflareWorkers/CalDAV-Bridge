import { BaseDAO } from '@rexezuge/d1';
import type { D1Queryable } from '@rexezuge/d1';

/**
 * A DAO whose rows carry a value encrypted with the app's master key.
 *
 * Provenance: CalDAV-Bridge's own `EncryptedDAO` (it lived in the old
 * `BaseDAO.ts`, which the kit's `@rexezuge/d1` replaced — the class is the
 * repo's own concern, so it moved out to its own file rather than migrating
 * with the kernel).
 *
 * The key is injected per DAO, never read from env here: the composition root
 * resolves it once, and a DAO that reached for the environment itself could not
 * be tested without a real secret.
 */
abstract class EncryptedDAO extends BaseDAO {
  public constructor(
    database: D1Queryable,
    protected readonly masterKey: string,
  ) {
    super(database);
  }
}

export { EncryptedDAO };
