import { ConnectedApplicationDAO } from '@/dao';
import { DEFAULT_OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS } from '@caldav-bridge/shared/constants';
import { OAuth2ProviderUtil } from './OAuth2ProviderUtil';
import { ConfigurationUtil } from './ConfigurationUtil';
import { CalendarProviderUtil } from './CalendarProviderUtil';

interface OAuth2AccessTokenEnv {
  DB: D1Database;
  AES_ENCRYPTION_KEY_SECRET: SecretsStoreSecret;
  OAUTH2_TOKEN_CACHE: KVNamespace;
  OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS?: string | undefined;
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
    if (!application) throw new Error('Connected application was not found.');
    const result = await OAuth2ProviderUtil.refreshAccessToken({ providerId: application.providerId, credentials: application.credentials });
    if (result.refreshToken) await applicationDAO.updateOAuth2RefreshToken(applicationId, result.refreshToken);
    const fallbackTtl = ConfigurationUtil.getPositiveInteger(env.OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS, DEFAULT_OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS);
    const ttl = Math.max(60, (result.expiresIn || fallbackTtl) - 60);
    await env.OAUTH2_TOKEN_CACHE.put(OAuth2AccessTokenService.cacheKey(applicationId), result.accessToken, { expirationTtl: ttl });
    return result.accessToken;
  }

  public static async completeAuthorization(applicationId: string, redirectUri: string, code: string, codeVerifier: string, env: OAuth2AccessTokenEnv): Promise<void> {
    const masterKey = await env.AES_ENCRYPTION_KEY_SECRET.get();
    const applicationDAO = new ConnectedApplicationDAO(env.DB, masterKey);
    const application = await applicationDAO.getById(applicationId);
    if (!application) throw new Error('Connected application was not found.');
    const result = await OAuth2ProviderUtil.exchangeCode({ providerId: application.providerId, credentials: application.credentials, redirectUri, code, codeVerifier });
    const profile = await CalendarProviderUtil.getProfile(application.providerId, result.accessToken);
    await applicationDAO.markOAuth2Connected(applicationId, result.refreshToken || application.credentials.refreshToken || '', profile.emailAddress);
    const fallbackTtl = ConfigurationUtil.getPositiveInteger(env.OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS, DEFAULT_OAUTH2_ACCESS_TOKEN_FALLBACK_TTL_SECONDS);
    await env.OAUTH2_TOKEN_CACHE.put(OAuth2AccessTokenService.cacheKey(applicationId), result.accessToken, { expirationTtl: Math.max(60, (result.expiresIn || fallbackTtl) - 60) });
  }

  private static cacheKey(applicationId: string): string {
    return `oauth2:${applicationId}`;
  }
}

export { OAuth2AccessTokenService };
export type { OAuth2AccessTokenEnv };
