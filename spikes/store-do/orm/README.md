# Task 0.2: Drizzle vs Prisma on Durable Object SQLite

Decision: **Drizzle** (`drizzle-orm/durable-sqlite`). Recorded as Ruling INFRA-CF-2 in `docs/RULINGS.md`.
The Prisma attempt is kept under `rejected/` (runnable, see "Reproduce").

## What each ships for DO SQLite and D1 (read from real source with `srcof`, tags 0.45.4 and 7.10.1; Prisma 6.19.3 installed)

|                      | Drizzle 0.45.4                                                           | Prisma 6.19.3                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DO SQLite driver     | `durable-sqlite/` (synchronous), `drizzle(ctx.storage)`                  | none. `@prisma/adapter-d1` is the only SQLite-on-Workers adapter and targets a D1 binding; `npm search` finds no DO adapter                                    |
| Transactions         | `session.ts:70` `ctx.storage.transactionSync(...)`, truly atomic, sync   | `adapter-d1/src/d1-worker.ts:195`: "D1 does not support transactions yet ... implicit and explicit transactions will be ignored and run as individual queries" |
| Engine               | none (query builder emits SQL)                                           | wasm QueryCompiler (1.8 MB), a compiler object per client, client built per request in production                                                              |
| Row-count of a write | `.returning()` (a conditional `UPDATE ... RETURNING` is the stock guard) | `updateMany().count`                                                                                                                                           |

## Measured (workerd 2026-08-15 via `wrangler dev --local`, wrangler 4.152, loopback; labelled measured, local only)

External wall clock from a Node loop, 300 requests per cell after 20 warmup, same seeded data (50 products), Prisma path built per
request over a local D1 (its best case; it cannot run inside the DO at all): `results/orm-local-2026-10-24.jsonl`.

| op                                | Drizzle p50 / p95 ms | Prisma p50 / p95 ms |
| --------------------------------- | -------------------- | ------------------- |
| list 24 products                  | 2.8 / 4.5            | 4.4 / 6.2           |
| add cart item (2 to 3 statements) | 3.0 / 6.0            | 6.0 / 8.8           |

In-worker `performance.now()` shows 0 ms for client construction: workerd freezes the clock during synchronous CPU, so construction
cost cannot be read from inside the Worker. The external loop is the honest measure (it includes construction).

Bundle (`wrangler deploy --dry-run --outdir`, minimal entry per ORM): Drizzle **177 KiB raw / 34 KiB gzip**;
Prisma **2214 KiB raw / 798 KiB gzip** (wasm 704 KiB gzip). Gate was under 300 KiB gzip: Drizzle passes, Prisma fails.

## Why it is decisive beyond speed

- Atomic money/stock sections need `transactionSync`. Prisma cannot reach it, and its D1 path silently drops transactions.
- Drizzle's DO wrapper is created once per DO lifetime in the constructor (zero per-request engine construction); the
  wasm QueryCompiler leak we just fixed (#177) cannot recur because there is no engine.

## Reproduce

```bash
cd spikes/store-do && npm install --legacy-peer-deps && npm run orm:prisma-generate
npx wrangler dev -c wrangler.orm.jsonc --local --port 8799 &
node orm/loop.mjs http://localhost:8799 300
for v in drizzle prisma; do npx wrangler deploy orm/bundle-$v.ts -c <(echo '{"name":"m","compatibility_date":"2026-08-01","compatibility_flags":["nodejs_compat"]}') --dry-run --outdir dist/$v; done
```

(`bundle-prisma.ts` lives in `rejected/`.)
