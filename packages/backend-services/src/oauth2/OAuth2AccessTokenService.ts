import { ConnectedApplicationDAO } from '@caldav-bridge/backend-data/dao';
import type { D1Queryable } from '@caldav-bridge/backend-data/utils';
import { InternalServerError } from '@caldav-bridge/backend-errors';
import { ConfigurationManager } from '@caldav-bridge/backend-runtime/config';
import { CalendarProviderUtil } from '@caldav-bridge/provider-clients/calendar';
import { OAuth2ProviderUtil } from '@caldav-bridge/provider-clients/oauth2';

interface OAuth2AccessTokenEnv {
  DB: D1Queryable;
  AES_ENCRYPTION_KEY_SECRET: SecretsStoreSecret;
  OAUTH2_TOKEN_CACHE: KVNamespace;
  OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS?: string | undefined;
  OAUTH2_ACCESS_TOKEN_MIN_VALID_SECONDS?: string | undefined;
}

class OAuth2AccessTokenService {
  public static async getAccessToken(applicationId: string, env: OAuth2AccessTokenEnv): Promise<string> {
    const cached = await env.OAUTH2_TOKEN_CACHE.get(OAuth2AccessTokenService.cacheKey(applicationId));
    if (cached) return cached;
    return OAuth2AccessTokenService.refreshAccessToken(applicationId, env);
  }

  public static async refreshAccessToken(applicationId: string, env: OAuth2AccessTokenEnv): Promise<string> {
    const masterKey = await env.AES_ENCRYPTION_KEY_SECRET.get();
    const applicationDAO = new ConnectedApplicationDAO(env.DB, masterKey);
    const application = await applicationDAO.getById(applicationId);
    if (!application) throw new InternalServerError('Connected application was not found.');
    const result = await OAuth2ProviderUtil.refreshAccessToken({
      providerId: application.providerId,
      credentials: application.credentials,
    });
    if (result.refreshToken) await applicationDAO.updateOAuth2RefreshToken(applicationId, result.refreshToken);
    await OAuth2AccessTokenService.cache(applicationId, result.accessToken, result.expiresIn, env);
    return result.accessToken;
  }

  public static async completeAuthorization(
    applicationId: string,
    redirectUri: string,
    code: string,
    codeVerifier: string,
    env: OAuth2AccessTokenEnv,
  ): Promise<void> {
    const masterKey = await env.AES_ENCRYPTION_KEY_SECRET.get();
    const applicationDAO = new ConnectedApplicationDAO(env.DB, masterKey);
    const application = await applicationDAO.getById(applicationId);
    if (!application) throw new InternalServerError('Connected application was not found.');
    const result = await OAuth2ProviderUtil.exchangeCode({
      providerId: application.providerId,
      credentials: application.credentials,
      redirectUri,
      code,
      codeVerifier,
    });
    const profile = await CalendarProviderUtil.getProfile(application.providerId, result.accessToken);
    await applicationDAO.markOAuth2Connected(
      applicationId,
      result.refreshToken || application.credentials.refreshToken || '',
      profile.emailAddress,
    );
    await OAuth2AccessTokenService.cache(applicationId, result.accessToken, result.expiresIn, env);
  }

  /**
   * Cache a token for less than its lifetime.
   *
   * The margin is the point: a token must be refreshed *before* it expires, not
   * after a request has already presented it to a provider and been rejected.
   * Both call sites computed this inline and hardcoded the 60-second margin, so
   * `OAUTH2_ACCESS_TOKEN_MIN_VALID_SECONDS` -- which was declared in
   * `wrangler.template.jsonc` -- changed nothing when it was edited.
   */
  private static async cache(applicationId: string, accessToken: string, expiresIn: number | undefined, env: OAuth2AccessTokenEnv): Promise<void> {
    const fallbackTtl = ConfigurationManager.oauth2.getAccessTokenFallbackTtlSeconds(env);
    const margin = ConfigurationManager.oauth2.getAccessTokenMinValidSeconds(env);
    await env.OAUTH2_TOKEN_CACHE.put(OAuth2AccessTokenService.cacheKey(applicationId), accessToken, {
      expirationTtl: Math.max(margin, (expiresIn || fallbackTtl) - margin),
    });
  }

  private static cacheKey(applicationId: string): string {
    return `oauth2:${applicationId}`;
  }
}

export { OAuth2AccessTokenService };
export type { OAuth2AccessTokenEnv };
