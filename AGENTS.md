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

## Git Commit Messages

- Use Conventional Commits with this subject format: `<TYPE>[optional scope]: <description>`.
- Write the type in uppercase, for example `FIX`, `FEAT`, `DOCS`, `STYLE`, `REFACTOR`, `TEST`, `BUILD`, `CHORE`.
- Write the optional scope in lowercase inside parentheses, for example `FEAT(runtime): Add Scheduled Job Status`.
- Write the description as concise human-readable words with spaces, capitalizing the first letter of each word.
- When creating a commit from `main`, first switch to a new branch generated from the planned commit subject.
- Use lowercase slash-separated branch names: `type/description` when there is no scope, or `type/scope/description` when there is a scope.
- Convert the description to kebab-case for the branch, for example `docs/latest-agents-context-reflection`.
- Use Markdown for optional commit bodies, separated from the subject by a blank line.
- Use optional footers after the body, separated by a blank line, following git trailer-style formatting.
- Use `FIX` for bug patches and `FEAT` for new features; other conventional types are allowed when they better describe the change.
- Mark breaking API changes with `!` after the type or scope, or with a `BREAKING CHANGE: <description>` footer.

```text
<TYPE>[optional scope]: <description>

[optional body in Markdown]

[optional footer(s)]
```
