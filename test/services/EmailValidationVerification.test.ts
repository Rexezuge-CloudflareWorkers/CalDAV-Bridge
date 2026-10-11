import { describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { UnauthorizedError } from '@rexezuge/errors';
import { EmailValidationUtil } from '@caldav-bridge/backend-services/auth';

/**
 * The verification half of `EmailValidationUtil`, against the real `jose`.
 *
 * The sibling test file covers the configuration branches that reject before
 * verification. What only a signed token can reach is the verified path: the
 * trailing-slash TEAM_DOMAIN normalization, the successful claim read, and a
 * token that verifies but carries no email. Those are the branches a
 * misconfigured Access deployment hits, and each has its own message — a token
 * without an email must not read as a failed verification.
 *
 * No module mocking: the JWKS fetch is stubbed (that is the only network call
 * the verifier makes) and the token is signed by a key pair this file owns.
 * A mock of `jose` here would register against whichever physical copy the
 * test happens to resolve — `packages/backend-services` has its own — while
 * the service calls its own, and the mock would silently not apply.
 */
const TEAM_DOMAIN = 'https://team.example.test';
const AUDIENCE = 'aud';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwks = { keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig' }] };

function stubJwksFetch(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } });
    }),
  );
  return { calls };
}

async function signToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(TEAM_DOMAIN)
    .setAudience(AUDIENCE)
    .setExpirationTime('1h')
    .sign(privateKey);
}

function requestWithToken(token: string): Request {
  return new Request('https://bridge.example.test/user/me', { headers: { 'cf-access-jwt-assertion': token } });
}

describe('EmailValidationUtil — a verified JWT', () => {
  it('returns the verified email address', async () => {
    stubJwksFetch();
    const token = await signToken({ email: 'person@example.test' });

    await expect(
      EmailValidationUtil.getAuthenticatedUserEmail(requestWithToken(token), { TEAM_DOMAIN, POLICY_AUD: AUDIENCE }),
    ).resolves.toBe('person@example.test');
  });

  it('normalizes a trailing slash on the team domain, in the JWKS URL and the issuer alike', async () => {
    // The trailing slash is what a dashboard copy-paste leaves behind. If it
    // survives into the JWKS URL the fetch 404s, and into the issuer the
    // verification fails — two different failures from one stray character.
    const { calls } = stubJwksFetch();
    const token = await signToken({ email: 'person@example.test' });

    await expect(
      EmailValidationUtil.getAuthenticatedUserEmail(requestWithToken(token), {
        TEAM_DOMAIN: `${TEAM_DOMAIN}/`,
        POLICY_AUD: AUDIENCE,
      }),
    ).resolves.toBe('person@example.test');
    expect(calls).toStrictEqual([`${TEAM_DOMAIN}/cdn-cgi/access/certs`]);
  });

  it('treats whitespace around the audience as configuration, not as a claim', async () => {
    stubJwksFetch();
    const token = await signToken({ email: 'person@example.test' });

    await expect(
      EmailValidationUtil.getAuthenticatedUserEmail(requestWithToken(token), { TEAM_DOMAIN, POLICY_AUD: `  ${AUDIENCE}  ` }),
    ).resolves.toBe('person@example.test');
  });

  it('reports a token that verified but carries no email', async () => {
    // A token signed by the right key with no email claim is a verified token
    // the repo cannot map to an account. It must say so, rather than read as
    // a verification failure and send an operator hunting for a key problem.
    stubJwksFetch();
    const token = await signToken({ sub: 'person' });

    await expect(
      EmailValidationUtil.getAuthenticatedUserEmail(requestWithToken(token), { TEAM_DOMAIN, POLICY_AUD: AUDIENCE }),
    ).rejects.toThrow('No email found in JWT token.');
  });

  it('wraps a verification failure with the underlying reason', async () => {
    stubJwksFetch();

    // A token this deployment's keys never signed: the JWKS resolves, the
    // signature check does not, and the reason travels with the error.
    const foreign = await generateKeyPair('RS256');
    const token = await new SignJWT({ email: 'person@example.test' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUDIENCE)
      .setExpirationTime('1h')
      .sign(foreign.privateKey);

    await expect(
      EmailValidationUtil.getAuthenticatedUserEmail(requestWithToken(token), { TEAM_DOMAIN, POLICY_AUD: AUDIENCE }),
    ).rejects.toThrow(/^JWT verification failed: /);
    await expect(
      EmailValidationUtil.getAuthenticatedUserEmail(requestWithToken(token), { TEAM_DOMAIN, POLICY_AUD: AUDIENCE }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
