/**
 * Super-admin activation view, read side (Ruling ACT-1). Per store: time from signup to each milestone, whether help was
 * needed at each step, and the last fact of an order that stopped. Plus the aggregate funnel over a signup date range.
 *
 * Source: the per-store activation file the daily CI aggregation writes (`lib/ci/aggregate/activation-file.ts`), one R2 get
 * per store. The store list is the platform directory (id, slug, name, status: explicit fields, already D1-served), walked
 * with a keyset cursor on `id`, so a page costs at most `limit` R2 reads.
 */
import { storeDirectory } from '@ebda/database';
import { cfBindings } from '../cf/bindings';
import type { CiBucket } from '../lib/ci/erase';
import { ciStoreActivationKey } from '../lib/ci/layout';
import {
  funnelOf,
  viewOf,
  type ActivationFile,
  type FunnelRow,
  type StoreActivationView,
} from '../lib/ci/aggregate/activation-file';

const ACTIVATION_PAGE_DEFAULT = 25;
const ACTIVATION_PAGE_MAX = 50;
/** Stores one funnel request reads (well under a Worker's 1000 subrequests); beyond it the answer says `truncated`. */
const FUNNEL_STORE_CAP = 600;
const READ_CHUNK = 100;

const bucket = (): CiBucket | undefined =>
  cfBindings()?.CI_BUCKET as unknown as CiBucket | undefined;

async function readFile(ci: CiBucket, storeId: string): Promise<ActivationFile | null> {
  const obj = await ci.get(ciStoreActivationKey(storeId));
  if (!obj) return null;
  try {
    const f = JSON.parse(await obj.text()) as ActivationFile;
    return f?.v === 1 ? f : null;
  } catch {
    return null;
  }
}

export interface ActivationRow extends StoreActivationView {
  name: string;
  slug: string;
  status: string;
}

export async function listActivation(
  q: { cursor?: string; limit?: number },
  ci: CiBucket | undefined = bucket()
): Promise<{ available: boolean; rows: ActivationRow[]; nextCursor: string | null }> {
  if (!ci) return { available: false, rows: [], nextCursor: null };
  const limit = Math.min(Math.max(q.limit ?? ACTIVATION_PAGE_DEFAULT, 1), ACTIVATION_PAGE_MAX);
  const all = (await storeDirectory()).sort((a, b) => (a.id < b.id ? -1 : 1));
  const after = q.cursor ? all.findIndex(s => s.id > q.cursor!) : 0;
  const page = after < 0 ? [] : all.slice(after, after + limit);
  const rows = await Promise.all(
    page.map(async s => ({
      ...viewOf(await readFile(ci, s.id), s.id),
      name: s.name,
      slug: s.slug,
      status: s.status,
    }))
  );
  const more = after >= 0 && after + limit < all.length;
  return { available: true, rows, nextCursor: more ? (page.at(-1)?.id ?? null) : null };
}

export async function activationFunnel(
  range: { fromMs: number; toMs: number },
  ci: CiBucket | undefined = bucket()
): Promise<{ available: boolean; rows: FunnelRow[]; stores: number; truncated: boolean }> {
  if (!ci) return { available: false, rows: [], stores: 0, truncated: false };
  const all = (await storeDirectory()).sort((a, b) => (a.id < b.id ? -1 : 1));
  const ids = all.slice(0, FUNNEL_STORE_CAP).map(s => s.id);
  const views: StoreActivationView[] = [];
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const chunk = ids.slice(i, i + READ_CHUNK);
    views.push(...(await Promise.all(chunk.map(async id => viewOf(await readFile(ci, id), id)))));
  }
  const rows = funnelOf(views, range.fromMs, range.toMs);
  return {
    available: true,
    rows,
    stores: views.filter(
      v => v.signupAt != null && v.signupAt >= range.fromMs && v.signupAt <= range.toMs
    ).length,
    truncated: all.length > FUNNEL_STORE_CAP,
  };
}
