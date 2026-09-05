import type { D1Queryable } from '../utils';

abstract class BaseDAO {
  constructor(protected readonly database: D1Queryable) {}
}

abstract class EncryptedDAO extends BaseDAO {
  constructor(database: D1Queryable, protected readonly masterKey: string) {
    super(database);
  }
}

export { BaseDAO, EncryptedDAO };
