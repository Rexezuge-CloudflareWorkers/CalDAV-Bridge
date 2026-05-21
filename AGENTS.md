# AGENTS.md

Guidance for agents working in CalDAV Bridge.

## Overview

CalDAV Bridge is a Cloudflare Worker API with a Vite React management UI. It connects Google Calendar and Microsoft Outlook Calendar over OAuth2 and exposes them through read/write CalDAV endpoints.

## Commands

Always source the user's toolchain setup before Node, pnpm, npm, npx, or Wrangler commands:

```bash
source ~/.customrc
volta run pnpm install
volta run pnpm run typecheck
volta run pnpm run test
volta run pnpm run build
volta run pnpm run typegen
```

## Architecture

- `apps/api/src/index.ts` exports `CalDavBridgeWorker` and `OAuth2TokenRefreshWorker`.
- `/user/*` is protected by Cloudflare Access.
- `/api/oauth2/callback/:applicationId` is public and secured by one-time state plus PKCE.
- `/dav/*` is public to Cloudflare Access and uses CalDAV Basic auth with generated CalDAV app passwords.
- `packages/shared/src/` contains shared constants, models, schemas, and utilities.
- `migrations/` contains D1 migrations.

## Provider Naming

- `google-calendar` / `oauth2`
- `microsoft-outlook-calendar` / `oauth2`
