# CalDAV Bridge

CalDAV Bridge is a Cloudflare Worker project that connects Google Calendar and Microsoft Outlook Calendar with OAuth2 and exposes those calendars through read/write CalDAV.

Users bring their own OAuth app credentials. The management UI creates connected calendar applications and multiple named CalDAV app passwords per application.

## Providers

- `google-calendar` / `oauth2`
- `microsoft-outlook-calendar` / `oauth2`

## Cloudflare Bindings

- D1 database binding: `DB`
- KV namespace: `OAUTH2_TOKEN_CACHE`
- Durable Object namespace: `OAUTH2_TOKEN_REFRESHERS`
- Secrets Store secret: `AES_ENCRYPTION_KEY_SECRET`

Copy `apps/api/wrangler.template.jsonc` to `wrangler.jsonc` and fill in the D1 database id, KV namespace id, secret store id, and routes.

## OAuth Setup

CalDAV Bridge generates one redirect URI per connected application:

```text
https://your-domain.example/api/oauth2/callback/{applicationId}
```

Required Google scopes:

```text
openid email profile https://www.googleapis.com/auth/calendar.events
```

Required Microsoft delegated permissions:

```text
User.Read Calendars.ReadWrite offline_access
```

## CalDAV

Use the management UI to generate one or more CalDAV app passwords for a connected application. The password is shown once.

CalDAV base URL:

```text
https://your-domain.example/dav/calendars/{applicationId}/
```

Username can be the connected application id or the credential name; authentication is resolved by the generated app password.

## Commands

```bash
source ~/.customrc
volta run pnpm install
volta run pnpm run typecheck
volta run pnpm run test
volta run pnpm run build
```
