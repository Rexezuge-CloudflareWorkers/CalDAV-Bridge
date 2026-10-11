// The structural D1 surface the DAOs program against — re-exported from the
// kit so a DAO statement built here and one built by a kit package are the
// same type, not two declarations that happen to look alike.
import type { D1Queryable } from '@rexezuge/d1';

type D1SessionEnv<TEnv extends { DB: D1Database }> = Omit<TEnv, 'DB'> & {
  DB: D1DatabaseSession;
};

function createD1SessionEnv<TEnv extends { DB: D1Database }>(
  env: TEnv,
  constraintOrBookmark: D1SessionBookmark | D1SessionConstraint = 'first-primary',
): D1SessionEnv<TEnv> {
  return {
    ...env,
    DB: env.DB.withSession(constraintOrBookmark),
  };
}

export { createD1SessionEnv };
export type { D1Queryable, D1SessionEnv };
