/**
 * The store directory read from D1 `ebda-platform` (Ruling NEON-ZERO-1): slug / custom domain / id -> store, with NO
 * Postgres. When the `PLATFORM_DB` binding exists (every deployed Worker) these are the ONLY source: an unknown store is
 * `null` (a 404 upstream), never a fallback to Postgres (tenant-resolver rule), and an unreadable D1 is a 503 (fail
 * closed). `platformDb()` is undefined only in Node / unit tests / local dev, where `lib/definer.ts` keeps its SQL
 * definers.
 *
 * Staleness class: NEVER-stale, no cache here (a read per call; the directory is a primary-key / unique-index SELECT).
 */
import { cfBindings } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';

interface DirD1 {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    };
  };
}

export function platformDb(): DirD1 | undefined {
  return (cfBindings() as { PLATFORM_DB?: DirD1 } | undefined)?.PLATFORM_DB;
}

const unavailable = () =>
  new AppError(503, 'PLATFORM_DIRECTORY_UNAVAILABLE', 'Store directory is unavailable');

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw unavailable();
  }
}

/** Same contract as the SQL definer `ebda_store_lookup`: id, then slug, then VERIFIED domain; not soft-deleted; among `statuses`. */
export async function d1LookupStore(
  db: DirD1,
  match: { id?: string | null; slug?: string | null; domain?: string | null },
  statuses: readonly string[]
): Promise<{ id: string; status: string } | null> {
  if (statuses.length === 0) return null;
  const marks = statuses.map((_, i) => `?${i + 4}`).join(', ');
  const row = await guarded(() =>
    db
      .prepare(
        `SELECT id, status FROM stores
          WHERE deleted_at IS NULL AND status IN (${marks})
            AND ((?1 IS NOT NULL AND id = ?1) OR (?2 IS NOT NULL AND slug = ?2)
              OR (?3 IS NOT NULL AND domain = ?3 AND domain_status = 'active'))
          ORDER BY (?1 IS NOT NULL AND id = ?1) DESC, (?2 IS NOT NULL AND slug = ?2) DESC
          LIMIT 1`
      )
      .bind(match.id ?? null, match.slug ?? null, match.domain ?? null, ...statuses)
      .first<{ id: string; status: string }>()
  );
  return row ? { id: row.id, status: row.status } : null;
}

/** `ebda_store_id_by_slug`: any status, soft-deleted included (the unique index covers them). */
export async function d1StoreIdBySlug(db: DirD1, slug: string): Promise<string | null> {
  const row = await guarded(() =>
    db.prepare('SELECT id FROM stores WHERE slug = ?1 LIMIT 1').bind(slug).first<{ id: string }>()
  );
  return row?.id ?? null;
}

/** `ebda_store_id_by_domain`: the store holding `domain` (any status). */
export async function d1StoreIdByDomain(db: DirD1, domain: string): Promise<string | null> {
  const row = await guarded(() =>
    db
      .prepare('SELECT id FROM stores WHERE domain = ?1 LIMIT 1')
      .bind(domain)
      .first<{ id: string }>()
  );
  return row?.id ?? null;
}

/** `ebda_store_ids_claiming_domain`: every store with a PENDING claim on `domain`. */
export async function d1StoreIdsClaimingDomain(db: DirD1, domain: string): Promise<string[]> {
  const { results } = await guarded(() =>
    db.prepare('SELECT id FROM stores WHERE pending_domain = ?1').bind(domain).all<{ id: string }>()
  );
  return (results ?? []).map(r => r.id);
}

/** `ebda_public_store_page`: active, live stores newest first (ids + total); take is clamped to 1..100 like the definer. */
export async function d1PublicStorePage(
  db: DirD1,
  skip: number,
  take: number
): Promise<{ ids: string[]; total: number }> {
  const offset = Math.max(Math.trunc(skip) || 0, 0);
  const limit = Math.min(Math.max(Math.trunc(take) || 1, 1), 100);
  const where = "status = 'active' AND deleted_at IS NULL";
  const [page, count] = await guarded(() =>
    Promise.all([
      db
        .prepare(
          `SELECT id FROM stores WHERE ${where} ORDER BY created_at DESC, id LIMIT ?1 OFFSET ?2`
        )
        .bind(limit, offset)
        .all<{ id: string }>(),
      db.prepare(`SELECT COUNT(*) AS n FROM stores WHERE ${where}`).bind().first<{ n: number }>(),
    ])
  );
  return { ids: (page.results ?? []).map(r => r.id), total: Number(count?.n ?? 0) };
}

/** Every live (not soft-deleted) store id of the D1 directory, id-ordered: the cross-store pages' store list (no Postgres definer). */
export async function d1ListStoreIds(db: DirD1): Promise<string[]> {
  return guarded(async () =>
    (
      (
        await db
          .prepare('SELECT id FROM stores WHERE deleted_at IS NULL ORDER BY id')
          .bind()
          .all<{ id: string }>()
      ).results ?? []
    ).map(r => r.id)
  );
}

export interface StoreBrief {
  id: string;
  slug: string;
  name: string;
  plan: string;
}

/** slug / name / plan of the named stores from the D1 directory (chunked: D1 allows 100 bound values per statement). */
export async function d1StoreBriefs(db: DirD1, ids: readonly string[]): Promise<StoreBrief[]> {
  const out: StoreBrief[] = [];
  const want = [...new Set(ids)];
  for (let i = 0; i < want.length; i += 90) {
    const part = want.slice(i, i + 90);
    out.push(
      ...(await guarded(
        async () =>
          (
            await db
              .prepare(
                `SELECT id, slug, name, plan FROM stores WHERE id IN (${part.map(() => '?').join(', ')})`
              )
              .bind(...part)
              .all<StoreBrief>()
          ).results ?? []
      ))
    );
  }
  return out;
}
