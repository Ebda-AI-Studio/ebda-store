/**
 * #1057 (+ product_views per #1062): StoreUsageSnapshot's revenueFils,
 * productViews, aiTokensIn, aiTokensOut and aiCostMicros were declared Int
 * (32-bit, max 2,147,483,647) while the writer (store-usage-snapshot.ts)
 * already computes each of them as a SQL BIGINT via a raw SUM()/COUNT() over
 * a store's month — a high-volume store's monthly total could exceed the
 * Int32 ceiling and either get silently truncated through `Number()` or fail
 * the upsert outright with "integer out of range".
 *
 * Asserts against the GENERATED Prisma DMMF (`Prisma.dmmf`), not schema.prisma
 * source text — the class of defect this file exists to catch is exactly
 * "the schema says one thing but nobody ran `prisma generate`", which a text
 * grep on schema.prisma cannot detect (the generated client is the thing
 * every runtime code path actually reads).
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@ebda/database';
import fs from 'node:fs';
import path from 'node:path';
import { callsIn, parseFile, strVal } from './helpers/ast-statements';

const BIGINT_FIELDS = ['revenueFils', 'productViews', 'aiTokensIn', 'aiTokensOut', 'aiCostMicros'];

describe('StoreUsageSnapshot BigInt widening (#1057)', () => {
  it('the GENERATED Prisma client has these 5 fields as BigInt', () => {
    const model = Prisma.dmmf.datamodel.models.find(m => m.name === 'StoreUsageSnapshot');
    expect(model, 'StoreUsageSnapshot model not found in the generated DMMF').toBeDefined();

    const types = Object.fromEntries(
      (model!.fields as Array<{ name: string; type: string }>)
        .filter(f => BIGINT_FIELDS.includes(f.name))
        .map(f => [f.name, f.type])
    );

    for (const field of BIGINT_FIELDS) {
      expect(
        types[field],
        `${field} is not BigInt in the generated client — run npm run db:generate`
      ).toBe('BigInt');
    }
  });

  it('the writer no longer truncates these fields through Number()', () => {
    // Source-text is the right tool for THIS assertion (unlike the schema
    // shape above): it is checking that a specific anti-pattern was removed
    // from one function, not whether a generated artifact matches source.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../apps/api/src/lib/inngest/functions/store-usage-snapshot.ts'),
      'utf-8'
    );
    for (const [prismaField, sqlField] of [
      ['revenueFils', 'revenue_fils'],
      ['productViews', 'product_views'],
      ['aiTokensIn', 'ai_tokens_in'],
      ['aiTokensOut', 'ai_tokens_out'],
      ['aiCostMicros', 'ai_cost_micros'],
    ] as const) {
      expect(
        src,
        `${prismaField} should pass through r.${sqlField} as a raw bigint, not Number(r.${sqlField})`
      ).not.toMatch(new RegExp(`${prismaField}:\\s*Number\\(r\\.${sqlField}\\)`));
      expect(src).toMatch(new RegExp(`${prismaField}:\\s*BigInt\\(r\\.${sqlField}\\)`));
    }
  });
});

describe('collect step output survives Inngest step memoization (JSON round-trip)', () => {
  it('bigint values past 2^53 round-trip exactly through JSON and back to BigInt', async () => {
    const { toJsonSafeRows } =
      await import('../../apps/api/src/lib/inngest/functions/store-usage-snapshot');
    const big = 9_007_199_254_740_993n; // 2^53 + 1: not representable as a JS number
    const rows = [{ store_id: 's1', revenue_fils: big, orders: 3n }];
    // What Inngest does with a completed step: stringify, then replay the parse.
    const replayed = JSON.parse(JSON.stringify(toJsonSafeRows(rows)));
    expect(BigInt(replayed[0].revenue_fils)).toBe(big);
    expect(Number(replayed[0].orders)).toBe(3);
    expect(replayed[0].store_id).toBe('s1');
  });

  it('the raw query result itself cannot cross a step boundary (the defect)', () => {
    expect(() => JSON.stringify([{ revenue_fils: 1n }])).toThrow(/BigInt/);
  });
});

describe('the collect step returns JSON-safe rows', () => {
  // Behaviour is not practical: the Inngest handler needs a store directory, RLS-scoped raw SQL and a DO backend. The
  // property is structural, so it is read off the parsed `step.run('collect', ...)` call, not a text window.
  it('pipes every raw query result through toJsonSafeRows', () => {
    const sf = parseFile('apps/api/src/lib/inngest/functions/store-usage-snapshot.ts');
    const collect = callsIn(sf, 'step.run').filter(c => strVal(c.arguments[0]) === 'collect');
    expect(collect).toHaveLength(1);
    const cb = collect[0]!.arguments[1]!;
    // the Postgres path: `<raw query>.then(toJsonSafeRows)`
    const thens = callsIn(cb, /\.then$/).filter(
      c => c.arguments.length === 1 && c.arguments[0]!.getText() === 'toJsonSafeRows'
    );
    expect(thens.length).toBeGreaterThanOrEqual(1);
    // the DO path: `toJsonSafeRows(await collectDoStoreUsage(...))`
    const direct = callsIn(cb, 'toJsonSafeRows');
    expect(direct).toHaveLength(1);
  });
});
