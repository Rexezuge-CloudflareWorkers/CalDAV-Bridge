#!/usr/bin/env tsx

/**
 * Ops: change a user's sign-in address.
 *
 * Wraps the three statements the change consists of, in this order:
 *
 *   1. claim the new address as verified for the account,
 *   2. move `users.current_email`,
 *   3. revoke every other verified address for that account.
 *
 * The order is the whole point. Claiming first means the user is never locked
 * out -- there is only a brief window where both addresses authenticate. Revoking
 * first opens a window where neither does.
 *
 * `users.email` is never touched. It is the frozen anchor that
 * `connected_applications.user_email` cascades from, so updating it would either
 * trip the foreign key or delete that user's applications -- and with them every
 * CalDAV credential, calendar mapping and OAuth2 session. Connected
 * applications, credentials and calendar data are keyed on the account id and are
 * unaffected by this change.
 *
 * Refuses (rather than half-applying) when the new address is already a live
 * login for a different account.
 *
 * Usage:
 *   pnpm exec tsx scripts/change-email.ts --db caldav-bridge-db --account alice@example.com --to new@example.com
 *   pnpm exec tsx scripts/change-email.ts --db caldav-bridge-db --id <user-uuid> --to new@example.com --dry-run
 *   pnpm exec tsx scripts/change-email.ts --db caldav-bridge-db --audit
 *
 * Flags:
 *   --db <name|binding>  required; D1 database name or binding
 *   --account <email>    match the current sign-in address
 *   --id <user-uuid>     match the stable account id (alternative to --account)
 *   --to <email>         the new sign-in address
 *   --audit              report addresses and duplicate anchors; changes nothing
 *   --config <path>      wrangler config (default ./wrangler.jsonc)
 *   --remote             run against the remote database (default: local)
 *   --dry-run            print the plan and the SQL, change nothing
 */
import { spawnSync } from 'node:child_process';

interface Args {
  db?: string;
  account?: string;
  id?: string;
  to?: string;
  audit: boolean;
  config: string;
  remote: boolean;
  dryRun: boolean;
  help: boolean;
}

interface AccountRow {
  user_id: string;
  anchor: string;
  current_email: string | null;
}

const USAGE = `Usage:
  pnpm exec tsx scripts/change-email.ts --db <name> (--account <email> | --id <user-uuid>) --to <new-email> [--remote] [--dry-run]
  pnpm exec tsx scripts/change-email.ts --db <name> --audit

Flags:
  --db <name>       D1 database name or binding (required)
  --account <email> the current sign-in address
  --id <user-uuid>  the stable account id
  --to <email>      the new sign-in address
  --audit           report addresses and duplicate anchors, changing nothing
  --config <path>   wrangler config (default ./wrangler.jsonc)
  --remote          run against the remote database (default: local)
  --dry-run         print the plan and SQL without changing anything
`;

function parseArgs(argv: string[]): Args {
  const out: Args = { audit: false, config: './wrangler.jsonc', remote: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--db') out.db = next();
    else if (arg === '--account') out.account = next();
    else if (arg === '--id') out.id = next();
    else if (arg === '--to') out.to = next();
    else if (arg === '--audit') out.audit = true;
    else if (arg === '--config') out.config = next();
    else if (arg === '--remote') out.remote = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function die(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/**
 * Single-quote a value for SQLite.
 *
 * The allowlist is the safety property here: this script interpolates into SQL,
 * so anything that is not a plain address or a plain id token is refused rather
 * than escaped-and-hoped. A bogus id simply matches no account.
 */
function sqlEmail(value: string): string {
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(value)) {
    die(`refusing to interpolate ${JSON.stringify(value)}: not a plain email address`);
  }
  return `'${value.toLowerCase()}'`;
}

function sqlToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.@-]+$/.test(value)) {
    die(`refusing to interpolate ${JSON.stringify(value)}: not a plain ${label}`);
  }
  return `'${value}'`;
}

interface QueryResult {
  results?: Array<Record<string, unknown>>;
}

function d1(args: Args, sql: string): QueryResult {
  const commandArgs = [
    'exec',
    'wrangler',
    'd1',
    'execute',
    args.db as string,
    '--command',
    sql,
    '--config',
    args.config,
    '--json',
    ...(args.remote ? ['--remote'] : ['--local']),
  ];
  // argv array rather than a shell string: nothing here is interpolated into a
  // command line, so a value can never break out into a second command.
  const result = spawnSync('pnpm', commandArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    die(`wrangler d1 execute failed:\n${(result.stderr || result.stdout || '').trim()}`);
  }
  // `wrangler --json` emits one JSON array per statement; a single statement is
  // the common case here.
  const stdout = (result.stdout || '').trim();
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1) die(`unexpected wrangler output: ${stdout.slice(0, 400)}`);
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) return (parsed[0] as QueryResult) ?? {};
  } catch {
    die(`could not parse wrangler output: ${stdout.slice(0, 400)}`);
  }
  return {};
}

/**
 * Report on identity state, changing nothing.
 *
 * Duplicate anchors matter because migration 0004 refuses to run when two
 * accounts differ only by the case of their address: `current_email` is
 * lowercased for every account, so `idx_users_current_email` cannot be created.
 * This is how an operator finds out before applying the migration rather than
 * after.
 */
function audit(args: Args): void {
  const duplicates = d1(
    args,
    `SELECT lower(email) AS folded, COUNT(*) AS accounts, group_concat(email, ' | ') AS anchors
     FROM users GROUP BY lower(email) HAVING COUNT(*) > 1 ORDER BY accounts DESC`,
  ).results;

  process.stdout.write(
    [`target    ${args.remote ? 'REMOTE' : 'local'} database '${args.db}'`, '', 'anchors differing only by case:'].join('\n'),
  );
  if (!duplicates || duplicates.length === 0) {
    process.stdout.write('  none\n');
  } else {
    for (const row of duplicates) {
      process.stdout.write(`  ${String(row['folded'])}  x${String(row['accounts'])}  ${String(row['anchors'])}\n`);
    }
    process.stdout.write(
      '\n  migration 0004 will ABORT on these and roll back cleanly (nothing is lost).\n' +
        '  Resolve them first: each is the same person, so keep one account and move\n' +
        '  their applications to it, then delete the others.\n',
    );
  }

  const accounts = d1(
    args,
    `SELECT u.user_id, u.email AS anchor, u.current_email,
            (SELECT group_concat(e.email || CASE WHEN e.is_verified = 1 THEN ' (live)' ELSE ' (revoked)' END, ' ')
             FROM user_emails e WHERE e.user_id = u.user_id) AS registry,
            (SELECT COUNT(*) FROM connected_applications c WHERE c.user_id = u.user_id) AS applications
     FROM users u ORDER BY u.created_at LIMIT 200`,
  ).results;

  process.stdout.write(`\naccounts (${accounts?.length ?? 0}):\n`);
  for (const row of accounts ?? []) {
    process.stdout.write(
      `  ${String(row['user_id'])}  ${String(row['current_email'] ?? '-')}  apps=${String(row['applications'])}  ` +
        `anchor=${String(row['anchor'])}  registry=${String(row['registry'] ?? '-')}\n`,
    );
  }
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!args.db) {
    process.stdout.write(USAGE);
    die('--db is required');
  }
  if (args.audit) {
    audit(args);
    return;
  }
  if ((!args.account && !args.id) || !args.to) {
    process.stdout.write(USAGE);
    die('one of --account or --id, plus --to, are required');
  }

  const target = sqlEmail(args.to);
  const selector = args.id
    ? { sql: `user_id = ${sqlToken(args.id, 'account id')}`, label: `id ${args.id}` }
    : { sql: `current_email = ${sqlEmail(args.account as string)}`, label: `account ${args.account}` };

  const found = d1(args, `SELECT user_id, email AS anchor, current_email FROM users WHERE ${selector.sql} LIMIT 1`);
  const account = (found.results ?? [])[0] as AccountRow | undefined;
  if (!account?.user_id) {
    die(
      `no account matched ${selector.label}. Match on the current sign-in address or the user id -- ` +
        'the frozen anchor is not searchable, because it may not be the sign-in address.',
    );
  }

  const holder = d1(
    args,
    `SELECT ue.user_id, ue.is_verified, u.current_email
     FROM user_emails ue JOIN users u ON u.user_id = ue.user_id
     WHERE ue.email = ${target} LIMIT 1`,
  );
  const existing = (holder.results ?? [])[0] as { user_id: string; is_verified: number; current_email: string | null } | undefined;
  if (existing && existing.is_verified === 1 && existing.user_id !== account.user_id) {
    die(
      `${args.to} is already a live login for account ${existing.user_id} (current_email ${existing.current_email ?? '?'}). ` +
        'Re-pointing it would hand that account to this user. Resolve the conflict first.',
    );
  }

  const current = account.current_email ?? account.anchor;
  const now = Math.floor(Date.now() / 1000);
  const userId = sqlToken(account.user_id, 'account id');
  const statements = [
    `INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (${target}, ${userId}, 1, ${now}) ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, is_verified = excluded.is_verified;`,
    `UPDATE users SET current_email = ${target}, updated_at = ${now} WHERE user_id = ${userId};`,
    `UPDATE user_emails SET is_verified = 0 WHERE user_id = ${userId} AND email != ${target};`,
  ];

  process.stdout.write(
    [
      `account   ${account.user_id}`,
      `anchor    ${account.anchor}  (frozen -- never updated)`,
      `from      ${current}`,
      `to        ${args.to?.toLowerCase()}`,
      `target    ${args.remote ? 'REMOTE' : 'local'} database '${args.db}'`,
      existing ? `note      ${args.to} already existed for this account (is_verified ${existing.is_verified}); it will be re-claimed` : '',
      '',
      'statements (applied in this order, as one batch):',
      ...statements.map((statement, index) => `  ${index + 1}. ${statement}`),
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  if (args.dryRun) {
    process.stdout.write('dry run -- nothing was changed.\n');
    return;
  }

  d1(args, statements.join(' '));
  const after = d1(
    args,
    `SELECT u.email AS anchor, u.current_email,
            (SELECT group_concat(e.email || ':' || e.is_verified, ' ') FROM user_emails e WHERE e.user_id = u.user_id) AS registry
     FROM users u WHERE u.user_id = ${userId}`,
  );
  const row = (after.results ?? [])[0] as { anchor: string; current_email: string; registry: string } | undefined;
  process.stdout.write(
    [
      '',
      'applied. verify:',
      `  anchor        ${row?.anchor ?? '?'}`,
      `  current_email ${row?.current_email ?? '?'}`,
      `  registry      ${row?.registry ?? '?'}`,
      '',
      'not touched, and still working: connected_applications, caldav_credentials,',
      'calendar_object_mappings and the OAuth2 sessions. They key on the account id.',
      '',
    ].join('\n'),
  );
}

main();
