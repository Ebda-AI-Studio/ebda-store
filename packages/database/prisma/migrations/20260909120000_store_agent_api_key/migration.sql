-- Per-store agent (MCP) WRITE credential.
--
-- Strictly additive and nullable: two new columns on `stores`, no existing
-- column is dropped, retyped, defaulted or made NOT NULL, and no index or
-- constraint is added. Every existing row keeps NULL, which means "this store
-- has no agent credential yet" — MCP READ tools are unaffected either way.
--
-- `agent_api_key` holds the AES-256-GCM ciphertext produced by
-- apps/api/src/services/encryption.service.ts (the same scheme `wbs_api_key`
-- uses, keyed off ENCRYPTION_KEY) — never a plaintext key, and never a hash,
-- so the column is deliberately NOT unique or indexed: it is only ever read
-- for one already-resolved store id, never scanned to find a store.
--
-- Hand-authored (no `prisma migrate dev`), applied with `prisma migrate deploy`.

ALTER TABLE "stores" ADD COLUMN "agent_api_key" TEXT;
ALTER TABLE "stores" ADD COLUMN "agent_api_key_rotated_at" TIMESTAMP(3);
