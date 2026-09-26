/**
 * E2E / Integration Test Setup
 *
 * Resolves the database connection string for integration/e2e tests and resets
 * the Prisma singleton so those suites connect to the correct (non-prod)
 * database.
 *
 * Resolution order (highest priority first):
 *   1. TEST_DATABASE_URL environment variable  ← preferred
 *   2. DATABASE_URL environment variable (e.g. CI's postgres service container)
 *   3. DATABASE_URL read from the repo .env file
 *
 * Every candidate is passed through the ALLOWLIST guard in
 * `tests/helpers/db-guard.ts`, which throws unless the host is one the suites
 * may seed and delete rows in. See that file for why it is an allowlist and
 * why it now lives in its own tested module.
 *
 * SUITE DETECTION: `expect.getState().testPath`, read inside `beforeAll`, so
 * it is accurate per test file. It must NOT be a module-load `process.argv`
 * read — under `pool: 'forks'` a worker's argv carries no test paths, which is
 * how the previous version of this file silently never ran at all. Unit tests
 * bail before any resolution so a developer whose local .env points at
 * production can still run them.
 */

import fs from 'fs';
import path from 'path';
import { beforeAll, expect } from 'vitest';
import { assertNotProd, assertTestPathKnown, isIntegrationTestPath } from './helpers/db-guard';

/** Resolve DATABASE_URL for this suite, guarding every candidate. */
function resolveTestDatabaseUrl(): void {
  // ── 1. TEST_DATABASE_URL — preferred path ──────────────────────────────────
  if (process.env.TEST_DATABASE_URL) {
    assertNotProd(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL env var');
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }
  // ── 2. DATABASE_URL already set (e.g. CI local postgres service) ───────────
  else if (process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('postgresql://test:')) {
    // If it's pointing at prod, refuse loudly instead of silently proceeding.
    assertNotProd(process.env.DATABASE_URL, 'DATABASE_URL env var');
    // Already set to a non-placeholder, non-prod URL — nothing to do.
  }
  // ── 3. Fall back to .env file ──────────────────────────────────────────────
  else {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        if (key === 'DATABASE_URL') {
          let value = trimmed.slice(eqIdx + 1).trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          // Guard: refuse to use the prod DB even when read from .env
          assertNotProd(value, `.env file (${envPath}) — set TEST_DATABASE_URL to avoid this`);
          process.env.DATABASE_URL = value;
          break;
        }
      }
    }

    // At this point DATABASE_URL is either the local placeholder or unset.
    // Warn so the developer knows they're running without a real DB.
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith('postgresql://test:')) {
      console.warn(
        '\n⚠  TEST_DATABASE_URL not set — integration tests will run against the ' +
          'local placeholder DB. ' +
          'Set TEST_DATABASE_URL to the staging Neon preview branch (ep-spring-dew-a1nn6819) ' +
          'for a more representative integration environment. See .env.example.\n'
      );
    }
  }
}

/**
 * Reset the Prisma singleton so it re-initialises against the resolved
 * DATABASE_URL rather than whatever the module-load default was.
 */
async function resetPrismaSingleton(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.prisma) {
    await g.prisma.$disconnect().catch(() => {});
    g.prisma = undefined;
  }
}

/**
 * Per-test-file setup for the integration/e2e suites.
 *
 * Registered unconditionally — Vitest cannot conditionally register hooks —
 * and bails immediately for unit test files. That ordering matters: a unit
 * test must never trip the DB guard just because a developer's local .env
 * points at production.
 *
 * NOTE ON THE REMOVED TRUNCATE: this hook used to also TRUNCATE the accounting
 * tables. That code had never executed (see the header), and waking it up on
 * 2026-08-31 broke CI — it wiped fixtures the wa-bridge suites depend on and
 * produced a 40P01 deadlock across parallel files. The suite has been green
 * without it for its entire life, so it is deliberately not reinstated here.
 * If accounting-table pollution ever returns, it belongs in a globalSetup that
 * runs ONCE per run, not in a per-file hook.
 */
beforeAll(async () => {
  const testPath = expect.getState().testPath;
  // Fails closed rather than silently skipping the guard below if Vitest
  // ever fails to report which file is running while a DB URL is configured
  // — see assertTestPathKnown's header for why "unknown" must not collapse
  // into "definitely not integration".
  assertTestPathKnown(testPath, Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL));
  if (!isIntegrationTestPath(testPath)) return;
  resolveTestDatabaseUrl();
  await resetPrismaSingleton();
});
