/**
 * The dead-Postgres route sweep (apps/api/workers-test/route-sweep.test.ts, cron group) fires EVERY Cron Trigger, then runs every
 * cron job body and the pg-copy-scrub queue message, and fails on any Postgres reach (POSTGRES_REMOVED, 2026-11-06 P1). This pins
 * its cron list to wrangler.jsonc, so a new schedule cannot ship unswept.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('route sweep cron list', () => {
  it('equals triggers.crons in apps/api/wrangler.jsonc', () => {
    const wrangler = read('apps/api/wrangler.jsonc').replace(/^\s*\/\/.*$/gm, '');
    const block = /"crons":\s*\[([\s\S]*?)\]/.exec(wrangler)![1]!;
    const wranglerCrons = [...block.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const swept = JSON.parse(read('apps/api/workers-test/cron-list.json')) as string[];
    expect([...swept].sort()).toEqual([...wranglerCrons].sort());
  });
  it('the sweep asserts reaches strictly and the cron allowlist is empty', () => {
    const sweep = read('apps/api/workers-test/route-sweep.test.ts');
    expect(sweep).toMatch(/const CRON_PG_ALLOWLIST: RegExp\[\] = \[\];/);
    expect(sweep).toContain('/__dev/run-jobs');
  });
});
