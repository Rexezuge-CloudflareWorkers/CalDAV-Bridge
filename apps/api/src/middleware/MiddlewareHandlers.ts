import { ServiceError } from '@caldav-bridge/backend-errors';
import { EmailValidationUtil } from '@caldav-bridge/backend-services/auth';
import { UserService } from '@caldav-bridge/backend-services/user';
import type { UserIdentity } from '@caldav-bridge/backend-services/user';
import { Context, Next } from 'hono';

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

class MiddlewareHandlers {
  public static userAuthentication() {
    return async (c: UserContext, next: Next): Promise<Response | void> => {
      try {
        const email: string = await EmailValidationUtil.getAuthenticatedUserEmail(c.req.raw, c.env);
        // The address is only an assertion at this point. Resolving it to an
        // account here is what lets an address change keep working: the request
        // is authorized against the account id, not the address it arrived with.
        const identity = await new UserService(c.env).upsertUser(email);
        c.set('AuthenticatedUser', identity);
        await next();
      } catch (error: unknown) {
        if (error instanceof ServiceError && error.getErrorCode() < 500) {
          return c.json({ error: error.getErrorMessage() }, error.getErrorCode());
        }
        throw error;
      }
    };
  }
}

export { MiddlewareHandlers };
