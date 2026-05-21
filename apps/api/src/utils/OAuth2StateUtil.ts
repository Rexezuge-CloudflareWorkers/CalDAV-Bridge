import { CryptoUtil } from '@caldav-bridge/shared/utils';

class OAuth2StateUtil {
  public static generateState(): string {
    return CryptoUtil.randomBase64Url(32);
  }

  public static generateCodeVerifier(): string {
    return CryptoUtil.randomBase64Url(64);
  }

  public static async getStateHash(state: string): Promise<string> {
    return CryptoUtil.sha256Hex(state);
  }

  public static async getCodeChallenge(codeVerifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    return CryptoUtil.base64UrlEncode(new Uint8Array(digest));
  }
}

export { OAuth2StateUtil };
