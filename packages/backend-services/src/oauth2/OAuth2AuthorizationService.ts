import { OAuth2AuthorizationSessionDAO } from '@caldav-bridge/backend-data/dao';
import type { D1Queryable } from '@caldav-bridge/backend-data/utils';
import { BadRequestError } from '@caldav-bridge/backend-errors';
import { ConfigurationManager } from '@caldav-bridge/backend-runtime/config';
import { OAuth2ProviderUtil } from '@caldav-bridge/provider-clients/oauth2';
import type { ConnectedApplication } from '@caldav-bridge/shared/model';
import { TimestampUtil } from '@caldav-bridge/shared/utils';
import { OAuth2AccessTokenService } from './OAuth2AccessTokenService';
import { OAuth2StateUtil } from './OAuth2StateUtil';

interface OAuth2AuthorizationEnv {
  DB: D1Queryable;
  AES_ENCRYPTION_KEY_SECRET: { get(): Promise<string> };
  OAUTH2_TOKEN_CACHE: KVNamespace;
}

interface OAuth2AuthorizationResult {
  authorizationUrl: string;
  redirectUri: string;
  expiresAt: number;
}

class OAuth2AuthorizationService {
  constructor(private readonly env: OAuth2AuthorizationEnv) {}

  public async createAuthorization(application: ConnectedApplication, baseUrl: string): Promise<OAuth2AuthorizationResult> {
    const state = OAuth2StateUtil.generateState();
    const codeVerifier = OAuth2StateUtil.generateCodeVerifier();
    const codeChallenge = await OAuth2StateUtil.getCodeChallenge(codeVerifier);
    const redirectUri = `${baseUrl}/api/oauth2/callback/${application.applicationId}`;
    const expiresAt = TimestampUtil.addMinutes(
      TimestampUtil.getCurrentUnixTimestampInSeconds(),
      ConfigurationManager.oauth2.getStateExpiryMinutes(this.env),
    );
    await new OAuth2AuthorizationSessionDAO(this.env.DB).create(
      application.applicationId,
      await OAuth2StateUtil.getStateHash(state),
      codeVerifier,
      redirectUri,
      expiresAt,
    );
    return {
      authorizationUrl: OAuth2ProviderUtil.buildAuthorizationUrl({
        providerId: application.providerId,
        clientId: application.credentials.clientId,
        redirectUri,
        state,
        codeChallenge,
      }),
      redirectUri,
      expiresAt,
    };
  }

  public async completeCallback(applicationId: string, code: string | null, state: string | null, providerError: string | null): Promise<{ redirect: string }> {
    if (providerError) return { redirect: `/user?oauth2=error&message=${encodeURIComponent(providerError)}` };
    if (!code || !state) throw new BadRequestError('OAuth2 callback is missing code or state.');
    const sessionDAO = new OAuth2AuthorizationSessionDAO(this.env.DB);
    const session = await sessionDAO.getActive(applicationId, await OAuth2StateUtil.getStateHash(state));
    if (!session) throw new BadRequestError('OAuth2 authorization session is invalid or expired.');
    await OAuth2AccessTokenService.completeAuthorization(applicationId, session.redirectUri, code, session.codeVerifier, this.env);
    await sessionDAO.consume(session.sessionId);
    return { redirect: `/user?oauth2=connected&applicationId=${encodeURIComponent(applicationId)}` };
  }
}

export { OAuth2AuthorizationService };
export type { OAuth2AuthorizationEnv, OAuth2AuthorizationResult };
