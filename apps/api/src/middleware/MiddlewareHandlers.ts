import { authenticateAccess } from '@rexezuge/http';
import { ServiceError } from '@rexezuge/errors';
import type { ResolvedAccount } from '@rexezuge/identity';
import { UserService } from '@caldav-bridge/backend-services/user';
import { Context, Next } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

type UserContext = Context<{
  Bindings: Env;
  Variables: {
    /**
     * The resolved account. Handlers key ownership on `id` and display `email`,
     * so neither depends on the address the request arrived with.
     */
    AuthenticatedUser: ResolvedAccount;
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
        const account = await new UserService(c.env).upsertUser(email);
        c.set('AuthenticatedUser', account);
        await next();
      } catch (error: unknown) {
        // A refused Access identity is a `ServiceError` now — the kit's
        // `AccessAuthError` extends `UnauthorizedError` — so it flows through
        // the same client-error mapping as any other refusal. There is no local
        // translation left to make.
        if (error instanceof ServiceError && error.status < 500) {
          // The kit's status is a plain number; hono's json() takes its
          // ContentfulStatusCode union, so the vetted status is narrowed
          // once, here, rather than at each of this repo's routes.
          return c.json({ error: error.message }, error.status as ContentfulStatusCode);
        }
        throw error;
      }
    };
  }
}

export { MiddlewareHandlers };
