import { describe, expect, it, vi } from 'vitest';
import { createD1SessionEnv } from '@caldav-bridge/backend-data/utils';

/**
 * A D1 session is what makes a read after a write see the write. The bookmark
 * that identifies the session has to survive the round trip, and it must not be
 * invented when the client has not sent one.
 */
describe('createD1SessionEnv', () => {
  const fakeEnv = (): { env: { DB: D1Database }; sessions: unknown[] } => {
    const sessions: unknown[] = [];
    const withSession = vi.fn((constraint: unknown) => {
      sessions.push(constraint);
      return { bookmark: String(constraint) };
    });
    return { env: { DB: { withSession } as unknown as D1Database }, sessions };
  };

  it('starts a first-primary session when the caller has no bookmark', () => {
    // A client arriving without a bookmark has no session to continue, so the
    // request has to open one against the primary rather than fail.
    const { env, sessions } = fakeEnv();

    const sessionEnv = createD1SessionEnv(env, undefined as never);

    expect(sessions).toEqual(['first-primary']);
    expect(sessionEnv.DB).toEqual({ bookmark: 'first-primary' });
  });

  it('continues the session the caller named', () => {
    const { env, sessions } = fakeEnv();

    createD1SessionEnv(env, 'bookmark-from-previous-response' as never);

    expect(sessions).toEqual(['bookmark-from-previous-response']);
  });

  it('carries every other binding through unchanged', () => {
    // The environment is spread rather than rebuilt, so a binding added later is
    // reachable without touching this function.
    const { env } = fakeEnv();

    const sessionEnv = createD1SessionEnv({ ...env, OAUTH2_TOKEN_CACHE: { get: () => null } } as never, 'bookmark' as never);

    expect(sessionEnv.OAUTH2_TOKEN_CACHE).toEqual({ get: expect.any(Function) });
  });

  it('replaces the database with the session, not the original', () => {
    const { env } = fakeEnv();

    const sessionEnv = createD1SessionEnv(env, 'bookmark' as never);

    // Leaving the original in place would send every query to the base database
    // and silently lose the consistency the session exists to provide.
    expect(sessionEnv.DB).not.toBe(env.DB);
  });
});
