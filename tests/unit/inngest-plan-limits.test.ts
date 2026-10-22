import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Ruling INNGEST-PLAN-1: Inngest rejects the WHOLE app sync when one function asks for more
// concurrency than the plan allows, so a single over-limit function silently freezes every
// function's registration (production stayed on its 2026-10-07 sync this way). Hobby = 5.
const PLAN_CONCURRENCY_LIMIT = 5;
const DIR = join(__dirname, '../../apps/api/src/lib/inngest/functions');

describe('inngest functions stay within the plan limits', () => {
  it(`no concurrency limit above ${PLAN_CONCURRENCY_LIMIT}`, () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DIR).filter(f => f.endsWith('.ts'))) {
      const src = readFileSync(join(DIR, file), 'utf8');
      for (const m of src.matchAll(/concurrency:\s*(?:\[[^\]]*\]|\{[^}]*\})/g)) {
        for (const l of m[0].matchAll(/limit:\s*(\d+)/g)) {
          if (Number(l[1]) > PLAN_CONCURRENCY_LIMIT) offenders.push(`${file}: limit ${l[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
