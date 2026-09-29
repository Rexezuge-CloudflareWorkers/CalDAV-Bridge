#!/usr/bin/env node
/**
 * Report source files that grew back into god-files.
 *
 * Excludes: node_modules, dist, locales, generated, tests, migrations, lockfiles.
 * Soft limit 300 LOC (warn), hard limit 400 LOC (critical).
 *
 * This is advisory only: it annotates the run and exits 0. The hard limit is a
 * ratchet, not a gate -- four files are still over it, and failing every push
 * until they are split would train everyone to ignore the report. Once they
 * are under 400, the `::error` annotation below can be raised to an exit 1.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SOFT = 300;
const HARD = 400;
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.wrangler', 'coverage', 'coverage-integration', '.git']);
const EXCLUDE_SUFFIX = ['.test.ts', '.spec.ts', '.int.test.ts', '.tsx.test.ts', '.d.ts'];

function shouldSkip(path) {
  if (path.includes('/locales/') || path.includes('/generated/') || path.includes('/__tests__/') || path.includes('/__mocks__/'))
    return true;
  // Tooling is not product source: build/lint/test configs and scripts grow
  // with project surface, not complexity. Guard only product + test code.
  if (path.includes('/scripts/')) return true;
  if (/\.config\.(m?[jt]s|cjs)$/.test(path)) return true;
  if (path.endsWith('.json') || path.endsWith('.sql') || path.endsWith('.md')) return true;
  if (EXCLUDE_SUFFIX.some((s) => path.endsWith(s))) return true;
  return false;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|js|mjs|cjs|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT).filter((f) => !shouldSkip(f));
const over = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n').length;
  if (lines > SOFT) {
    over.push({ file: relative(ROOT, file), lines, level: lines > HARD ? 'CRITICAL' : 'WARN' });
  }
}
over.sort((a, b) => b.lines - a.lines);
for (const o of over.slice(0, 30)) {
  console.log(`${o.level} ${o.lines} ${o.file}`);
  // Annotated so the report is visible on the pull request without opening logs.
  console.log(`::warning title=God-File Check::${o.file} is ${o.lines} lines (${o.level})`);
}

const critical = over.filter((o) => o.level === 'CRITICAL');
if (critical.length > 0) {
  console.log(`\nGod-file check: ${critical.length} file(s) exceed ${HARD} LOC (advisory, not failing). Split them.`);
} else {
  console.log(`\nGod-file check passed (${files.length} files, ${over.length} over soft limit ${SOFT}).`);
}
