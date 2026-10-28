# Phase 2 architecture: how the repo layer reaches 2,500 Prisma call sites (Ruling CF-REPO-1, PROPOSED)

Status: proposal with a working spike. Needs Ahmad's go before the services move. Labels: **measured** = a number from this tree/run, **inferred**, **guess**.

## The problem (measured)

- 2,489 Prisma ORM calls in 258 files under `apps/api/src` (findMany 491, findUnique 448, findFirst 426, update 378, create 199, count 198, updateMany 174, deleteMany 70, ...) plus 279 raw SQL sites (plan section 3) and 43 locks.
- Hand-writing one repo method per use case (plan task 2.1/2.3) means rewriting every service. `ProductService.listPublic` alone is about 500 lines of filters, facets, hybrid search, merchant ordering and caching.
- Each StoreDO RPC is a billed request (phase-0 memo): a service that makes 8 queries must not become 8 RPCs.

## Proposal

1. **Raw-SQL sites and locks become `StoreRepo` methods exactly as planned** (domain methods, Postgres implementation = today's SQL, DO implementation = SQLite inside `transactionSync`). These are the sites that cannot be portable: SECURITY DEFINER wrappers, `FOR UPDATE`, advisory locks, `GREATEST/ANY/::float8`, trigram search, stock/wallet/loyalty/sequence/gold sections.
2. **The ~2,200 ORM sites are NOT rewritten.** A Prisma-shaped client (`packages/repo/src/prisma-lite`) runs over the DO's SQLite using generated metadata (`packages/cf-schema/generated/prisma-meta.json`: tables, columns, enums, resolved relations). The services keep calling `prisma.product.findMany({ where, select, include, orderBy, take })`.
3. **A store-scoped request runs inside the StoreDO** (one billed DO request per HTTP request, data colocated), the same Worker bundle, with the request-bound `prisma` resolved to prisma-lite. Postgres stays the default per store until cutover (flag unchanged).
4. Verification: **differential tests** run the same query through real Prisma/Postgres and prisma-lite over the same rows and demand deep equality; the existing 200+ integration tests then run with `DB_BACKEND=sqlite` as the end-to-end proof.

## Spike evidence (measured, this branch)

`packages/repo/test/prisma-lite-reads.diff.test.ts`: 13 differential cases against local Postgres 17 + pgvector, all identical on the first full run: ordering and paging, range/in/NOT, insensitive and case-sensitive `contains` (Arabic and Latin), relation `some`/`none`, nullability, the real storefront listing shape (`images take 2`, `categories include`, `variants select`), `_count`, ordering through a joined relation, `count`, compound-unique `findUnique`. About 450 lines of engine. Not yet covered: writes, nested writes, `aggregate/groupBy`, `$transaction`, error codes (P2002/P2025), `upsert`, `createMany`, increments, JSON path filters, `distinct`, cursor semantics, and the DO runtime itself.

## Costs and risks

- **Effort (guess):** reads done in spike; writes + nested writes + aggregates + transactions + error mapping about 3 to 4 days with the differential suite; raw-SQL repo methods about 1 week; DO-hosted request pipeline (tenant-context, `withMoneyTx`, savepoints, `deferAfterTenantCommit` replaced by DO equivalents) about 3 to 4 days; money/stock phase 3 as planned. Roughly 2.5 to 3 weeks of agent work, not days, for the whole of phases 2 and 3.
- **Risk 1, fidelity:** a Prisma behaviour prisma-lite does not reproduce. Mitigation: differential tests per operator, plus the integration suite on the SQLite backend before any store moves.
- **Risk 2, hosting the request in the DO:** CPU and memory of one DO per hot store (single-threaded, 128 MB); a slow third-party call inside a DO request blocks that store. Mitigation: external I/O stays outside money sections; measure p95 under k6 at the phase-3 gate.
- **Risk 3, Decimal and Date semantics:** encoded in `codec.ts`, covered by the diff cases that touch them.
- **Alternative (plan as written):** rewrite 258 files to repo methods: 4 to 6 weeks (guess), more regression surface, no single behavioural oracle.

Cost if wrong: prisma-lite is additive and flag-gated; if fidelity proves too costly the services can still be moved to repo methods one by one, because the repo interfaces are built either way.
