import { describe, expect, it } from 'vitest';
import { CONNECTION_METHOD_OAUTH2, PROVIDER_GOOGLE_CALENDAR } from '@caldav-bridge/shared/constants';
import { validateRequestInput } from '@caldav-bridge/shared/schema';

const APPLICATION_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';

describe('request input validation', () => {
  it('validates and trims connected application bodies', async () => {
    const result = await validateRequestInput(
      new Request('https://bridge.example.test/user/application', { method: 'POST' }),
      {
        displayName: ' Work Calendar ',
        providerId: PROVIDER_GOOGLE_CALENDAR,
        connectionMethod: CONNECTION_METHOD_OAUTH2,
        clientId: ' client-id ',
        clientSecret: ' client-secret ',
      },
    );

    expect(result).toEqual({
      success: true,
      data: {
        displayName: 'Work Calendar',
        providerId: PROVIDER_GOOGLE_CALENDAR,
        connectionMethod: CONNECTION_METHOD_OAUTH2,
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
    });
  });

  it('rejects invalid provider IDs, UUIDs, and positive integer fields', async () => {
    await expect(
      validateRequestInput(new Request('https://bridge.example.test/user/application', { method: 'POST' }), {
        displayName: 'Calendar',
        providerId: 'not-supported',
        connectionMethod: CONNECTION_METHOD_OAUTH2,
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }),
    ).resolves.toMatchObject({ success: false });

    await expect(
      validateRequestInput(new Request('https://bridge.example.test/user/application/caldav-credential', { method: 'POST' }), {
        applicationId: APPLICATION_ID,
        name: 'Phone',
        expiresInDays: 0,
      }),
    ).resolves.toEqual({ success: false, error: 'expiresInDays must be positive.' });

    await expect(
      validateRequestInput(new Request('https://bridge.example.test/user/application/caldav-credential', { method: 'DELETE' }), {
        applicationId: APPLICATION_ID,
        credentialId: 'not-a-uuid',
      }),
    ).resolves.toMatchObject({ success: false });
  });

  it('validates GET query input instead of request bodies', async () => {
    await expect(
      validateRequestInput(new Request(`https://bridge.example.test/user/application/calendars?applicationId=${APPLICATION_ID}`), { ignored: true }),
    ).resolves.toEqual({ success: true, data: { applicationId: APPLICATION_ID } });

    await expect(
      validateRequestInput(new Request('https://bridge.example.test/user/application/calendars?applicationId=bad'), { ignored: true }),
    ).resolves.toMatchObject({ success: false });
  });

  it('validates OAuth2 callback query combinations on dynamic callback routes', async () => {
    await expect(
      validateRequestInput(new Request(`https://bridge.example.test/api/oauth2/callback/${APPLICATION_ID}?code=code&state=state`), {}),
    ).resolves.toEqual({ success: true, data: { code: 'code', state: 'state' } });

    await expect(
      validateRequestInput(new Request(`https://bridge.example.test/api/oauth2/callback/${APPLICATION_ID}?error=access_denied`), {}),
    ).resolves.toEqual({ success: true, data: { error: 'access_denied' } });

    await expect(
      validateRequestInput(new Request(`https://bridge.example.test/api/oauth2/callback/${APPLICATION_ID}?code=code`), {}),
    ).resolves.toEqual({ success: false, error: 'OAuth2 callback requires code and state.' });
  });

  it('passes through routes without configured schemas', async () => {
    const body = { credentialId: CREDENTIAL_ID };

    await expect(validateRequestInput(new Request('https://bridge.example.test/user/me'), body)).resolves.toEqual({ success: true, data: body });
  });
});
