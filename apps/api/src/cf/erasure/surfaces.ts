import type {
  CustomerSubject,
  ErasureSurface,
  ExportPart,
  IdentityPort,
  R2BucketLike,
  Subject,
  StoreDoStub,
  SuppressionPort,
  SurfaceResult,
} from './types';
import { dropCiBuyerIndex, eraseCiBuyerInStore } from '../../lib/ci/erase';

const ndjson = (rows: unknown[]) =>
  rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

export async function listAll(r2: R2BucketLike, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await r2.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function deletePrefix(r2: R2BucketLike, prefix: string): Promise<number> {
  const keys = await listAll(r2, prefix);
  for (let i = 0; i < keys.length; i += 1000) await r2.delete(keys.slice(i, i + 1000));
  return keys.length;
}

// ---------------------------------------------------------------- CI (R2 ebda-ci)
export const ciBuyerIndexKey = (buyerKey: string) =>
  `index/buyer/${buyerKey.slice(0, 2)}/${buyerKey}.json`;
export const ciStorePrefix = (storeId: string) => `outcomes/v1/store=${storeId}/`;
/** CI-2 per-store day and window aggregates (Ruling CI-9): the merchant's own counters, deleted with the store. */
export const ciStoreAggPrefix = (storeId: string) => `aggregates/v1/store=${storeId}/`;

export async function gzipText(text: string): Promise<Uint8Array> {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function gunzipText(buf: ArrayBuffer): Promise<string> {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}

/** Stores a buyer appears in, from the buyer index (partition keys contain `store=<id>/`). */
export async function ciStoresFor(ci: R2BucketLike, buyerKey: string): Promise<string[]> {
  const idx = await ci.get(ciBuyerIndexKey(buyerKey));
  if (!idx) return [];
  const { partitions } = JSON.parse(await idx.text()) as { partitions: string[] };
  return [
    ...new Set(partitions.map(p => /store=([^/]+)\//.exec(p)?.[1]).filter(Boolean) as string[]),
  ];
}

export function ciSurface(ci: R2BucketLike): ErasureSurface {
  const partitionsOf = async (buyerKey: string) => {
    const idx = await ci.get(ciBuyerIndexKey(buyerKey));
    return idx ? (JSON.parse(await idx.text()) as { partitions: string[] }).partitions : [];
  };
  return {
    name: 'customer-intelligence',
    async exportSubject(s): Promise<ExportPart> {
      if (s.kind === 'merchant') {
        // Per-merchant export: the store's own outcome partitions, verbatim.
        const keys = await listAll(ci, ciStorePrefix(s.storeId));
        const lines: string[] = [];
        for (const k of keys) {
          const o = await ci.get(k);
          if (o)
            lines.push(...(await gunzipText(await o.arrayBuffer())).split('\n').filter(Boolean));
        }
        return {
          surface: 'customer-intelligence',
          ndjson: lines.join('\n') + (lines.length ? '\n' : ''),
          records: lines.length,
        };
      }
      const out: string[] = [];
      for (const p of await partitionsOf(s.buyerKey)) {
        const o = await ci.get(p);
        if (!o) continue;
        for (const line of (await gunzipText(await o.arrayBuffer())).split('\n').filter(Boolean))
          if ((JSON.parse(line) as { buyerKey?: string }).buyerKey === s.buyerKey) out.push(line);
      }
      return {
        surface: 'customer-intelligence',
        ndjson: out.join('\n') + (out.length ? '\n' : ''),
        records: out.length,
      };
    },
    async eraseSubject(s): Promise<SurfaceResult> {
      if (s.kind === 'merchant') {
        const erased =
          (await deletePrefix(ci, ciStorePrefix(s.storeId))) +
          (await deletePrefix(ci, ciStoreAggPrefix(s.storeId)));
        return {
          surface: 'customer-intelligence',
          erased,
          remaining:
            (await listAll(ci, ciStorePrefix(s.storeId))).length +
            (await listAll(ci, ciStoreAggPrefix(s.storeId))).length,
        };
      }
      // Store-scoped (Ruling CI-8): a buyer key is a hash of a typed phone, so it never erases across
      // stores on its own. Each store is erased through lib/ci/erase (tombstone first, index pass then
      // prefix pass); the stores come from the request, else from the buyer index's partitions.
      const stores = s.storeIds ?? [
        ...new Set(
          (await partitionsOf(s.buyerKey))
            .map(p => /store=([^/]+)\//.exec(p)?.[1])
            .filter((x): x is string => !!x)
        ),
      ];
      let erased = 0;
      let remaining = 0;
      for (const storeId of stores) {
        for (const mode of ['index', 'prefix'] as const) {
          const r = await eraseCiBuyerInStore(ci, { storeId, buyerKeys: [s.buyerKey] }, mode);
          erased += r.erased;
          if (mode === 'prefix') remaining += r.remaining;
        }
      }
      // Every store the index knew was just erased; an explicit store list leaves the rest of the index.
      if (!s.storeIds) await dropCiBuyerIndex(ci, s.buyerKey);
      return { surface: 'customer-intelligence', erased, remaining };
    },
  };
}

// ---------------------------------------------------------------- R2 media
export function mediaSurface(media: R2BucketLike): ErasureSurface {
  const prefix = (storeId: string) => `stores/${storeId}/`;
  return {
    name: 'media',
    async exportSubject(s): Promise<ExportPart> {
      // Customers own no media. A merchant export lists the object keys (the files themselves are
      // downloadable from the public CDN URLs the merchant already has; copying GBs into a bundle is not export).
      if (s.kind === 'customer') return { surface: 'media', ndjson: '', records: 0 };
      const keys = await listAll(media, prefix(s.storeId));
      return { surface: 'media', ndjson: ndjson(keys.map(key => ({ key }))), records: keys.length };
    },
    async eraseSubject(s) {
      if (s.kind === 'customer')
        return { surface: 'media', erased: 0, remaining: 0, note: 'customers own no media' };
      const erased = await deletePrefix(media, prefix(s.storeId));
      return {
        surface: 'media',
        erased,
        remaining: (await listAll(media, prefix(s.storeId))).length,
      };
    },
  };
}

// ---------------------------------------------------------------- identity
export function identitySurface(id: IdentityPort): ErasureSurface {
  const userIds = (s: Subject): string[] =>
    s.kind === 'merchant' ? [s.ownerUserId, ...(s.staffUserIds ?? [])] : s.userId ? [s.userId] : [];
  return {
    name: 'identity',
    async exportSubject(s): Promise<ExportPart> {
      const rows: unknown[] = [];
      for (const u of userIds(s)) rows.push({ userId: u, data: await id.exportUser(u) }); // already secret-free per the contract
      return { surface: 'identity', ndjson: ndjson(rows), records: rows.length };
    },
    async eraseSubject(s) {
      let erased = 0;
      let remaining = 0;
      for (const u of userIds(s)) {
        const r = await id.eraseUser(u, s.requestId);
        // erased:false with remaining:0 is the idempotent repeat (already gone), not a failure.
        if (r.erased) erased += 1;
        remaining += r.remaining;
      }
      return { surface: 'identity', erased, remaining };
    },
  };
}

// ---------------------------------------------------------------- email suppression
export function suppressionSurface(sup: SuppressionPort): ErasureSurface {
  return {
    name: 'email-suppression',
    async exportSubject(s): Promise<ExportPart> {
      const email = s.kind === 'customer' ? s.email : undefined;
      const rows = email ? await sup.exportFor(email) : [];
      return { surface: 'email-suppression', ndjson: ndjson(rows), records: rows.length };
    },
    async eraseSubject(s) {
      // A merchant's own address lives in identity; suppression entries are about customers.
      const email = s.kind === 'customer' ? s.email : undefined;
      if (!email)
        return {
          surface: 'email-suppression',
          erased: 0,
          remaining: 0,
          note: 'no email on subject',
        };
      const { rows } = await sup.tombstone(null, email);
      return {
        surface: 'email-suppression',
        erased: rows,
        remaining: await sup.remainingPlain(email),
      };
    },
  };
}

// ---------------------------------------------------------------- StoreDO
export function storeDoSurface(
  stubFor: (storeId: string) => StoreDoStub,
  storesOf: (s: Subject) => Promise<string[]>
): ErasureSurface {
  return {
    name: 'store-do',
    async exportSubject(s): Promise<ExportPart> {
      const rows: unknown[] = [];
      for (const storeId of await storesOf(s)) {
        const { tables } = await stubFor(storeId).exportSubject(s);
        for (const [table, rs] of Object.entries(tables))
          for (const row of rs) rows.push({ storeId, table, row });
      }
      return { surface: 'store-do', ndjson: ndjson(rows), records: rows.length };
    },
    async eraseSubject(s) {
      const storeIds = await storesOf(s);
      // ALL-OR-NOTHING (Ruling NZ-D20): a merchant's stores are gated TOGETHER before any is touched. One store with money in flight
      // refuses the whole erasure, so no clean sibling is anonymised and sealed while the job halts before identity / media / CI.
      if (s.kind === 'merchant') {
        let inFlight = 0;
        for (const storeId of storeIds) {
          const gate = await stubFor(storeId).moneyInFlight();
          inFlight += Object.values(gate).reduce((a, b) => a + b, 0);
        }
        if (inFlight > 0)
          return {
            surface: 'store-do',
            erased: 0,
            remaining: inFlight,
            note: 'refused: money in flight (settle it, then retry)',
          };
      }
      let erased = 0;
      let remaining = 0;
      let refused = false;
      for (const storeId of storeIds) {
        const r = await stubFor(storeId).eraseSubject(s);
        erased += Object.values(r.erased).reduce((a, b) => a + b, 0);
        remaining += r.remaining;
        if (r.refused) refused = true;
      }
      return {
        surface: 'store-do',
        erased,
        remaining,
        ...(refused ? { note: 'refused: money in flight (settle it, then retry)' } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------- platform payments (N-27)
/** The platform-side payer PII of a merchant's InstaPay receipts and manual-payment claims (services/billing/payments-erasure.ts). */
export interface PaymentsErasurePort {
  /** Anonymise (never delete) the payer fields of these stores' rows; idempotent. */
  scrub(storeIds: string[], requestId: string, now?: Date): Promise<{ erased: number }>;
  /** Rows of these stores still holding a payer value. */
  remaining(storeIds: string[]): Promise<number>;
}

/**
 * Merchant erasure of the platform payments tables. It must run AFTER the `store-do` surface (cf/erasure/job.ts runs that
 * one first, as the money gate, and stops the job when it refuses), so payer PII is never anonymised while money is in
 * flight. A customer subject has no platform payer rows of its own (order receipts live in the StoreDO).
 */
export function paymentsSurface(
  port: PaymentsErasurePort,
  storesOf: (s: Subject) => Promise<string[]>
): ErasureSurface {
  return {
    name: 'platform-payments',
    async exportSubject(): Promise<ExportPart> {
      return { surface: 'platform-payments', ndjson: '', records: 0 };
    },
    async eraseSubject(s) {
      if (s.kind !== 'merchant') return { surface: 'platform-payments', erased: 0, remaining: 0 };
      const storeIds = await storesOf(s);
      const { erased } = await port.scrub(storeIds, s.requestId);
      return { surface: 'platform-payments', erased, remaining: await port.remaining(storeIds) };
    },
  };
}

export type { CustomerSubject };
