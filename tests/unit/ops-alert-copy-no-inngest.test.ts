/** Ruling JOBS-ORPHAN-1: operator-facing alert strings must not send an operator to Inngest (removed in #294). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = [
  'queue-depth-watch.ts',
  'order-created-stuck-sweep.ts',
  'order-status-fanout-stuck-sweep.ts',
  'refund-reversal-stuck-sweep.ts',
  'alerts-failure-watch.ts',
];
const dir = join(__dirname, '../../apps/api/src/lib/inngest/functions');

describe('operator-facing alert copy', () => {
  for (const f of FILES) {
    it(`${f}: no Inngest dashboard / re-PUT advice in title/body strings`, () => {
      const src = readFileSync(join(dir, f), 'utf8');
      const code = src
        .split('\n')
        .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      expect(code).not.toMatch(
        /re-PUT|api\/v1\/inngest|inngest dashboard|in Inngest|Inngest delivery|inngest function failed:/i
      );
      expect(code).not.toMatch(/source:\s*['"`]inngest\.queue-depth/);
    });
  }
});
