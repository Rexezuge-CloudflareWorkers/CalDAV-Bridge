import { describe, expect, it } from 'vitest';
import { UnauthorizedError } from '@caldav-bridge/backend-errors';
import { EmailValidationUtil } from '@caldav-bridge/backend-services/auth';

describe('EmailValidationUtil', () => {
  it('honors the local development bypass', async () => {
    await expect(
      EmailValidationUtil.getAuthenticatedUserEmail(new Request('https://bridge.example.test/user/me'), { DEV_AUTH_EMAIL: 'dev@example.test' }),
    ).resolves.toBe('dev@example.test');
  });

  it('rejects requests without Access credentials or configuration', async () => {
    const request = new Request('https://bridge.example.test/user/me');

    await expect(EmailValidationUtil.getAuthenticatedUserEmail(request, {})).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      EmailValidationUtil.getAuthenticatedUserEmail(new Request('https://bridge.example.test/user/me', { headers: { 'cf-access-jwt-assertion': 'token' } }), {}),
    ).rejects.toThrow('TEAM_DOMAIN or POLICY_AUD');
  });

  it('rejects unparsable audiences and unreachable issuers', async () => {
    const headers = { 'cf-access-jwt-assertion': 'invalid-token' };
    const request = () => new Request('https://bridge.example.test/user/me', { headers });

    await expect(
      EmailValidationUtil.getAuthenticatedUserEmail(request(), { TEAM_DOMAIN: 'https://team.example.test', POLICY_AUD: 'a,b' }),
    ).rejects.toThrow('Multiple JWT audiences');
    await expect(
      EmailValidationUtil.getAuthenticatedUserEmail(request(), { TEAM_DOMAIN: 'https://team.example.test', POLICY_AUD: 'aud' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
