import { z } from 'zod';
import { CONNECTION_METHOD_OAUTH2, PROVIDER_GOOGLE_CALENDAR, PROVIDER_MICROSOFT_OUTLOOK_CALENDAR } from '../constants';

const UuidSchema = z.uuid();

function nonEmptyStringSchema(name: string, maxLength: number) {
  return z.string().trim().min(1, `${name} is required.`).max(maxLength, `${name} is too long.`);
}

function positiveIntegerBodySchema(name: string) {
  return z.number().int(`${name} must be an integer.`).positive(`${name} must be positive.`);
}

const ConnectedApplicationBaseSchema = z.object({
  displayName: nonEmptyStringSchema('displayName', 128),
  providerId: z.enum([PROVIDER_GOOGLE_CALENDAR, PROVIDER_MICROSOFT_OUTLOOK_CALENDAR]),
  connectionMethod: z.literal(CONNECTION_METHOD_OAUTH2),
  clientId: nonEmptyStringSchema('clientId', 512),
  clientSecret: nonEmptyStringSchema('clientSecret', 2048),
});

export { ConnectedApplicationBaseSchema, UuidSchema, nonEmptyStringSchema, positiveIntegerBodySchema };
