import { OAuth2AccessTokenService } from '@/utils/OAuth2AccessTokenService';
import { errorResponse, jsonResponse } from '@/utils';

class OAuth2TokenRefreshWorker {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  public async fetch(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as { applicationId?: string; redirectUri?: string; code?: string; codeVerifier?: string };
      if (!body.applicationId) return jsonResponse({ error: 'applicationId is required.' }, 400);
      if (new URL(request.url).pathname.endsWith('/exchange')) {
        if (!body.redirectUri || !body.code || !body.codeVerifier) return jsonResponse({ error: 'OAuth2 exchange input is incomplete.' }, 400);
        await this.state.blockConcurrencyWhile(() => OAuth2AccessTokenService.completeAuthorization(body.applicationId || '', body.redirectUri || '', body.code || '', body.codeVerifier || '', this.env));
        return jsonResponse({ success: true });
      }
      const accessToken = await this.state.blockConcurrencyWhile(() => OAuth2AccessTokenService.refreshAccessToken(body.applicationId || '', this.env));
      return jsonResponse({ accessToken });
    } catch (error) {
      return errorResponse(error);
    }
  }
}

export { OAuth2TokenRefreshWorker };
