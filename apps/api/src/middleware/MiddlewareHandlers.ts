import { AccessAuthError, authenticateAccess } from '@rexezuge/http';
import { ServiceError, UnauthorizedError } from '@rexezuge/errors';
import { UserService } from '@caldav-bridge/backend-services/user';
import type { UserIdentity } from '@caldav-bridge/backend-services/user';
import { Context, Next } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

type UserContext = Context<{
  Bindings: Env;
  Variables: {
    /**
     * The resolved account. Handlers key ownership on `userId` and display
     * `currentEmail`, so neither depends on the address the request arrived with.
     */
    AuthenticatedUser: UserIdentity;
  };
}>;

/**
 * The Cloudflare Access configuration, read structurally.
 *
 * `DEV_AUTH_EMAIL` is deliberately absent from the wrangler template (and so
 * from `CloudflareEnv`): it is a local-dev-only bypass, and a var the template
 * does not name cannot be enabled by a deploy. Reading it through this shape
 * keeps that property — a deploy that never sets it has no bypass.
 */
interface AccessEnv {
  DEV_AUTH_EMAIL?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
}

class MiddlewareHandlers {
  public static userAuthentication() {
    return async (c: UserContext, next: Next): Promise<Response | void> => {
      try {
        // The kit's Cloudflare Access authentication: dev bypass, then the
        // `cf-access-jwt-assertion` header, then the `ACCESS` binding — with the
        // JWKS cache and the collapsed failure messages the family converged on.
        // There is no repo-local JWT path to keep beside it.
        const accessEnv = c.env as AccessEnv;
        const email: string = await authenticateAccess(c.req.raw, undefined, {
          // The operator-set DEV_AUTH_EMAIL is itself the switch, so the
          // allow-list is open here and the environment decides whether a dev
          // identity exists at all.
          bypassAllowed: true,
          devAuthEmail: accessEnv.DEV_AUTH_EMAIL,
          teamDomain: accessEnv.TEAM_DOMAIN,
          policyAud: accessEnv.POLICY_AUD,
        });
        // The address is only an assertion at this point. Resolving it to an
        // account here is what lets an address change keep working: the request
        // is authorized against the account id, not the address it arrived with.
        const identity = await new UserService(c.env).upsertUser(email);
        c.set('AuthenticatedUser', identity);
        await next();
      } catch (error: unknown) {
        // AccessAuthError is deliberately not a ServiceError: a rejected address
        // is not something a caller catches as one. It is translated here, at
        // the boundary that knows a refusal is a 401, and then flows through the
        // same mapping as any other client error.
        const mapped: unknown =
          error instanceof AccessAuthError ? new UnauthorizedError('Cloudflare Access authentication failed.') : error;
        if (mapped instanceof ServiceError && mapped.status < 500) {
          // The kit's status is a plain number; hono's json() takes its
          // ContentfulStatusCode union, so the vetted status is narrowed
          // once, here, rather than at each of this repo's routes.
          return c.json({ error: mapped.message }, mapped.status as ContentfulStatusCode);
        }
        throw mapped;
      }
    };
  }
}

export { MiddlewareHandlers };
