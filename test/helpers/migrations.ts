import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

interface MigrationFile {
  name: string;
  sql: string;
}

/** Migration files in apply order. */
function migrationFiles(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(resolve(MIGRATIONS_DIR, name), 'utf-8') }));
}

/**
 * Minimal SQL statement splitter for SQLite migration files.
 *
 * Handles single/double/backtick quoted strings (including `''` escapes),
 * `--` line comments and block comments; a semicolon inside a string or a
 * comment does not split. This matters because the migration files document
 * themselves heavily: a comment explaining `CREATE UNIQUE INDEX` contains
 * semicolons, and splitting on those yields fragments that are not valid SQL.
 */
function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index] as string;

    if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      index = newline === -1 ? sql.length : newline;
      continue;
    }

    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      current += char;
      index += 1;
      while (index < sql.length) {
        const inner = sql[index] as string;
        current += inner;
        index += 1;
        if (inner !== quote) continue;
        // A doubled quote is an escaped quote, not a terminator.
        if (sql[index] === quote) {
          current += quote;
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * Apply migration files to an open `node:sqlite` database.
 *
 * `from`/`to` select an inclusive range of file names, so a test can seed the
 * pre-identity schema and then apply only the identity migration. Each file runs
 * in its own transaction, mirroring `wrangler d1 migrations apply`: a file that
 * aborts leaves the database exactly as it was, which is what the
 * case-variant-duplicate assertion depends on.
 */
function applyMigrations(database: DatabaseSync, options: { from?: string; to?: string } = {}): string[] {
  const files = migrationFiles();
  const from = options.from ? files.findIndex((file) => file.name === options.from) : 0;
  const end = options.to ? files.findIndex((file) => file.name === options.to) + 1 : files.length;
  if (from === -1) throw new Error(`Unknown migration file: ${options.from}`);
  if (end === 0) throw new Error(`Unknown migration file: ${options.to}`);

  const applied: string[] = [];
  for (const file of files.slice(from, end)) {
    database.exec('BEGIN');
    try {
      for (const statement of splitSql(file.sql)) database.exec(statement);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`Migration ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    applied.push(file.name);
  }
  return applied;
}

export { applyMigrations, migrationFiles, splitSql };
export type { MigrationFile };
