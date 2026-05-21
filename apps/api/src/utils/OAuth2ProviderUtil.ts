import { PROVIDER_GOOGLE_CALENDAR, PROVIDER_MICROSOFT_OUTLOOK_CALENDAR } from '@caldav-bridge/shared/constants';
import type { OAuth2Credentials, ProviderId } from '@caldav-bridge/shared';
import { HttpError } from './HttpError';

interface OAuth2AuthorizationInput {
  providerId: ProviderId | string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

interface OAuth2TokenExchangeInput {
  providerId: ProviderId | string;
  credentials: OAuth2Credentials;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

interface OAuth2RefreshInput {
  providerId: ProviderId | string;
  credentials: OAuth2Credentials;
}

interface OAuth2TokenResult {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresIn?: number | undefined;
}

const ProviderConfig = {
  [PROVIDER_GOOGLE_CALENDAR]: {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile https://www.googleapis.com/auth/calendar.events',
  },
  [PROVIDER_MICROSOFT_OUTLOOK_CALENDAR]: {
    authorizationEndpoint: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
    tokenEndpoint: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite offline_access',
  },
} as const;

class OAuth2ProviderUtil {
  public static buildAuthorizationUrl(input: OAuth2AuthorizationInput): string {
    const config = OAuth2ProviderUtil.getProviderConfig(input.providerId);
    const url = new URL(config.authorizationEndpoint);
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', config.scope);
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (input.providerId === PROVIDER_GOOGLE_CALENDAR) {
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
    } else if (input.providerId === PROVIDER_MICROSOFT_OUTLOOK_CALENDAR) {
      url.searchParams.set('response_mode', 'query');
    }
    return url.toString();
  }

  public static async exchangeCode(input: OAuth2TokenExchangeInput): Promise<OAuth2TokenResult> {
    const config = OAuth2ProviderUtil.getProviderConfig(input.providerId);
    const data = await OAuth2ProviderUtil.postTokenRequest(config.tokenEndpoint, {
      client_id: input.credentials.clientId,
      client_secret: input.credentials.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    });
    if (!data.refresh_token) throw new HttpError(400, 'OAuth2 provider did not return a refresh token. Reconnect and approve offline access.');
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: OAuth2ProviderUtil.parseExpiresIn(data.expires_in) };
  }

  public static async refreshAccessToken(input: OAuth2RefreshInput): Promise<OAuth2TokenResult> {
    if (!input.credentials.refreshToken) throw new HttpError(400, 'Connected application is not fully authorized.');
    const config = OAuth2ProviderUtil.getProviderConfig(input.providerId);
    const data = await OAuth2ProviderUtil.postTokenRequest(config.tokenEndpoint, {
      client_id: input.credentials.clientId,
      client_secret: input.credentials.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: input.credentials.refreshToken,
    });
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: OAuth2ProviderUtil.parseExpiresIn(data.expires_in) };
  }

  private static getProviderConfig(providerId: string) {
    const config = ProviderConfig[providerId as keyof typeof ProviderConfig];
    if (!config) throw new HttpError(400, `Unsupported OAuth2 provider: ${providerId}`);
    return config;
  }

  private static async postTokenRequest(tokenEndpoint: string, values: Record<string, string>): Promise<OAuth2TokenResponse> {
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values),
    });
    const data = (await response.json()) as OAuth2TokenResponse;
    if (!response.ok || !data.access_token) {
      throw new HttpError(response.status >= 400 && response.status < 500 ? 400 : 502, `OAuth2 token request failed: ${data.error_description || data.error || response.statusText}`);
    }
    return data;
  }

  private static parseExpiresIn(expiresIn: number | string | undefined): number | undefined {
    const parsed = Number(expiresIn);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
}

interface OAuth2TokenResponse {
  access_token: string;
  refresh_token?: string | undefined;
  expires_in?: number | string | undefined;
  error?: string | undefined;
  error_description?: string | undefined;
}

export { OAuth2ProviderUtil };
export type { OAuth2TokenResult };
