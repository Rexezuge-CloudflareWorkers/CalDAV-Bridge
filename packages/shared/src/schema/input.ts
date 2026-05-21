import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { ConnectedApplicationBaseSchema, UuidSchema, nonEmptyStringSchema, positiveIntegerBodySchema } from './common';

interface RequestInputSchema {
  body?: ZodTypeAny | undefined;
  query?: ZodTypeAny | undefined;
}

const CreateApplicationBodySchema = ConnectedApplicationBaseSchema;
const UpdateApplicationBodySchema = ConnectedApplicationBaseSchema.extend({ applicationId: UuidSchema });
const DeleteApplicationBodySchema = z.object({ applicationId: UuidSchema });
const OAuth2AuthorizeBodySchema = z.object({ applicationId: UuidSchema });
const ApplicationIdQuerySchema = z.object({ applicationId: UuidSchema });
const CreateCalDavCredentialBodySchema = z.object({
  applicationId: UuidSchema,
  name: nonEmptyStringSchema('name', 128),
  expiresInDays: positiveIntegerBodySchema('expiresInDays').optional(),
});
const DeleteCalDavCredentialBodySchema = z.object({
  applicationId: UuidSchema,
  credentialId: UuidSchema,
});
const OAuth2CallbackQuerySchema = z
  .object({
    code: nonEmptyStringSchema('code', 4096).optional(),
    state: nonEmptyStringSchema('state', 512).optional(),
    error: nonEmptyStringSchema('error', 1024).optional(),
  })
  .refine((input): boolean => Boolean(input.error || (input.code && input.state)), 'OAuth2 callback requires code and state.');

const RequestInputSchemas: Record<string, RequestInputSchema> = {
  'POST /user/application': { body: CreateApplicationBodySchema },
  'PUT /user/application': { body: UpdateApplicationBodySchema },
  'DELETE /user/application': { body: DeleteApplicationBodySchema },
  'POST /user/application/oauth2/authorize': { body: OAuth2AuthorizeBodySchema },
  'GET /user/application/calendars': { query: ApplicationIdQuerySchema },
  'GET /user/application/caldav-credentials': { query: ApplicationIdQuerySchema },
  'POST /user/application/caldav-credential': { body: CreateCalDavCredentialBodySchema },
  'DELETE /user/application/caldav-credential': { body: DeleteCalDavCredentialBodySchema },
  'GET /api/oauth2/callback/:applicationId': { query: OAuth2CallbackQuerySchema },
};

export { RequestInputSchemas };
export type { RequestInputSchema };
