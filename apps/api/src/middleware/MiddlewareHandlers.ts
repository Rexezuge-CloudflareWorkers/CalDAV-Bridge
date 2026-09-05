import { ServiceError } from '@caldav-bridge/backend-errors';
import { EmailValidationUtil } from '@caldav-bridge/backend-services/auth';
import { UserService } from '@caldav-bridge/backend-services/user';
import { Context, Next } from 'hono';

type UserContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

class MiddlewareHandlers {
  public static userAuthentication() {
    return async (c: UserContext, next: Next): Promise<Response | void> => {
      try {
        const userEmail: string = await EmailValidationUtil.getAuthenticatedUserEmail(c.req.raw, c.env);
        await new UserService(c.env).upsertUser(userEmail);
        c.set('AuthenticatedUserEmailAddress', userEmail);
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
