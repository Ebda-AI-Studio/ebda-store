/**
 * E2E Test Setup
 * Loads the real DATABASE_URL from the project .env file and resets the
 * Prisma singleton so e2e tests connect to the actual database.
 *
 * This file must be listed in setupFiles AFTER the global tests/setup.ts so
 * that it can override the fake DATABASE_URL set there.
 */

import fs from 'fs';
import path from 'path';

// Load .env from project root if DATABASE_URL looks like the test placeholder
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith('postgresql://test:')) {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      // Only set DATABASE_URL — don't override other env vars already set
      if (key === 'DATABASE_URL') {
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env.DATABASE_URL = value;
        break;
      }
    }
  }
}

// Reset the Prisma singleton so it re-initializes with the real DATABASE_URL
const g = globalThis as any;
if (g.prisma) {
  await g.prisma.$disconnect().catch(() => {});
  g.prisma = undefined;
}
