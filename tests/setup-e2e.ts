/**
 * E2E / Integration Test Setup
 * Resolves the database connection string for integration/e2e tests and resets
 * the Prisma singleton so tests connect to the correct (non-prod) database.
 *
 * Resolution order (highest priority first):
 *   1. TEST_DATABASE_URL environment variable  ← preferred (staging Neon preview branch)
 *   2. DATABASE_URL environment variable — ONLY when it doesn't point at prod
 *   3. DATABASE_URL read from .env file — ONLY when it doesn't point at prod
 *
 * PRODUCTION GUARD: if the resolved host is the prod Neon endpoint
 * (ep-falling-meadow-a1uq2yil) this file throws immediately. Integration
 * tests MUST NOT run against the prod database.
 *
 * Vitest loads setupFiles for EVERY test run (unit, integration, e2e). Unit
 * tests don't touch the DB and shouldn't trip the prod guard just because
 * the developer's local .env happens to point at production. We detect the
 * suite from process.argv and short-circuit on non-integration runs.
 */

import fs from 'fs';
import path from 'path';

const argvJoined = process.argv.join(' ');
const isIntegrationRun =
  argvJoined.includes('tests/integration') ||
  argvJoined.includes('tests/e2e') ||
  process.env.VITEST_E2E === 'true';

// Prod endpoint fragment — any connection string containing this host is prod.
const PROD_HOST_FRAGMENT = 'ep-falling-meadow-a1uq2yil';

function extractHost(connStr: string): string {
  try {
    // postgresql://user:pass@host:port/db?...
    const withoutScheme = connStr.replace(/^[a-z]+:\/\/[^@]+@/, '');
    return withoutScheme.split(/[:/?]/)[0];
  } catch {
    return connStr;
  }
}

function isProd(connStr: string): boolean {
  return connStr.includes(PROD_HOST_FRAGMENT);
}

function guardNotProd(connStr: string, source: string): void {
  if (isProd(connStr)) {
    throw new Error(
      `\n\n🚨  PROD DB GUARD TRIGGERED — integration tests tried to connect to production!\n` +
        `    Source: ${source}\n` +
        `    Host:   ${extractHost(connStr)}\n\n` +
        `    Set TEST_DATABASE_URL to the staging Neon preview branch (ep-spring-dew-a1nn6819)\n` +
        `    before running integration tests. See .env.example for the exact format.\n`
    );
  }
}

if (isIntegrationRun) {
  // ── 1. TEST_DATABASE_URL — preferred path ──────────────────────────────────
  if (process.env.TEST_DATABASE_URL) {
    guardNotProd(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL env var');
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }
  // ── 2. DATABASE_URL already set (e.g. CI local postgres service) ───────────
  else if (process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('postgresql://test:')) {
    // If it's pointing at prod, refuse loudly instead of silently proceeding.
    guardNotProd(process.env.DATABASE_URL, 'DATABASE_URL env var');
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
          guardNotProd(value, `.env file (${envPath}) — set TEST_DATABASE_URL to avoid this`);
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

  // Reset the Prisma singleton so it re-initializes with the resolved DATABASE_URL.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.prisma) {
    await g.prisma.$disconnect().catch(() => {});
    g.prisma = undefined;
  }
}
