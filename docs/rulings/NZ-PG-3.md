# NZ-PG-3

> Section: NEON-ZERO Postgres remnants (2026-11-05)

**Ruling NZ-PG-3 - `acrossStores` without a filter or id list visits EVERY store (the full `storeDirectory()`); the capped, `truncated`-losing `hubStoreIds` hook is removed.** The hook took the first 500 stores of `hubFanoutStoreIds()` and dropped the `truncated` flag, so a cron past 500 stores silently skipped the rest. The request-bound super-admin views keep their documented bound (`SUPER_ADMIN_FANOUT_CAP`, Ruling FP-7: a warning when cut) because they pass their own `storeIds`. Evidence: `packages/database/src/__tests__/scope-resolver.test.ts` (1205 stores, none cut). Cost if wrong: a very large fleet makes one cron run longer (4 stores at a time), never incomplete.
