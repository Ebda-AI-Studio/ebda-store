/**
 * The D1 `entity_index` table a StoreDO writes its id -> store rows to before a money op answers (Ruling NZ-MONEY-2). The
 * test binds an empty PLATFORM_DB; without the table every index write fails and a reference-minting op answers 503, which is
 * the OUTAGE case, not the one these files measure. DDL = packages/cf-schema/migrations/platform/0001_init.sql.
 */
import { env } from 'cloudflare:test';

export async function ensurePlatformIndex(): Promise<void> {
  const d1 = (env as unknown as { PLATFORM_DB: { exec(sql: string): Promise<unknown> } })
    .PLATFORM_DB;
  await d1.exec(
    `CREATE TABLE IF NOT EXISTS "entity_index" ("kind" TEXT NOT NULL, "id" TEXT NOT NULL, "store_id" TEXT NOT NULL, "claim_ref" TEXT, "created_at" INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)), CONSTRAINT "entity_index_pkey" PRIMARY KEY ("kind", "id"))`
  );
}
