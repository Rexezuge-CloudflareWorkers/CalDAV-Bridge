import { describe, expect, it } from 'vitest';
import { CalDavCredentialUtil } from '@caldav-bridge/shared/utils';

describe('CalDavCredentialUtil', () => {
  it('generates CalDAV Bridge app passwords with metadata', async () => {
    const password = CalDavCredentialUtil.generatePassword();

    expect(password.startsWith('cb_')).toBe(true);
    expect(password.length).toBeGreaterThan(30);
    expect(CalDavCredentialUtil.getPrefix(password)).toBe(password.slice(0, 10));
    expect(CalDavCredentialUtil.getLastFour(password)).toBe(password.slice(-4));
    await expect(CalDavCredentialUtil.hashPassword(password)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates CalDAV usernames from an animal and four digits', () => {
    const username = CalDavCredentialUtil.generateUsername();

    expect(username).toMatch(/^[a-z]+\d{4}$/);
  });
});
