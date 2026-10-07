/**
 * Page documents for the visual builder (Phase 1): draft / publish /
 * revisions / rollback over `store_page_revisions`, with optimistic
 * concurrency.
 *
 * Model (one row per revision, `rev` monotonic per store+page):
 *   - HEAD rev = max(rev) for the page; it is the concurrency token every
 *     write names (`baseRev`). A write whose baseRev is not the head gets
 *     409 REV_CONFLICT with the latest document — never a silent overwrite.
 *   - at most ONE `draft` row (the working copy, updated in place, its rev
 *     bumped to head+1 on every save) and ONE `published` row (partial
 *     unique indexes); publish promotes the draft and archives the previous
 *     published row, so history is the archived rows.
 *   - a page with no published row renders from `stores.layout_settings`
 *     through the adapter (nothing to backfill).
 *   - publish / rollback BACK-WRITE `stores.layout_settings` with the
 *     document's projection (`definitionToLayout`) in the same transaction,
 *     so every legacy reader (chrome, PLP/PDP page settings, the admin) keeps
 *     reading what the storefront renders. One writer: this service owns
 *     `layout_settings` writes (the legacy PUT routes through
 *     `publishLegacyLayout`).
 *
 * Every query runs on the ambient tenant transaction (`tenantContext`), so
 * RLS confines it to the caller's store; the explicit `storeId` filters are
 * defence in depth. Race losers fail on a row lock re-check or a unique
 * index inside a SAVEPOINT, so the request transaction survives to answer 409.
 *
 * Caches (bounded-stale class: layout/content): a publish/rollback purges
 * every layer through `bustStoreCaches` AFTER the commit
 * (`deferAfterTenantCommit`) — Redis `public:store:*` (+ generation bump),
 * the storefront Next data cache via the `layout:<storeId>` tag, and the
 * store's slug/host/domain resolve keys. Draft saves touch no public cache.
 */
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@force/database';
import {
  BUILDER_LIMITS,
  PAGE_DEFINITION_SCHEMA_VERSION,
  definitionToLayout,
  layoutToDefinition,
  resolveLayoutSettings,
  validateDefinition,
  type BuilderIssue,
  type PageDefinition,
  type StoreLayoutSettings,
  type TemplateId,
} from '@force/shared';
import { withSavepoint } from '../lib/savepoint';
import { readInStoreContext } from '../lib/store-scoped-read';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { bustStoreCaches } from './store.service';
import { cleanupRemovedJsonUrls } from './r2-cleanup.service';
import logger from '../lib/logger';

export const HOME_PAGE_KEY = 'home';

export type RevisionStatus = 'draft' | 'published' | 'archived';

interface RevisionRow {
  id: string;
  rev: number;
  status: string;
  document: unknown;
  docBytes: number;
  baseRev: number | null;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
}

export interface PageState {
  /** Head rev (0 = no revision rows yet). Name it as `baseRev` on the next write. */
  rev: number;
  /** What the editor should open: the draft, else published, else the layout-derived document. */
  definition: PageDefinition;
  source: 'draft' | 'published' | 'layout';
  draftRev: number | null;
  publishedRev: number | null;
}

export type ServiceResult<T> =
  | { ok: true; value: T; warnings?: BuilderIssue[] }
  | {
      ok: false;
      status: 404 | 409 | 422;
      code: string;
      message: string;
      errors?: BuilderIssue[];
      latest?: PageState;
    };

class RevConflict extends Error {}

/** A lost unique race (P2002) — the one-draft / one-published / rev indexes. */
const isP2002 = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'P2002';

const META_SELECT = {
  id: true,
  rev: true,
  status: true,
  docBytes: true,
  baseRev: true,
  note: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
} as const;

const docBytes = (d: unknown) => Buffer.byteLength(JSON.stringify(d), 'utf8');

async function loadStore(storeId: string) {
  return prisma.store.findUnique({
    where: { id: storeId },
    select: { layoutSettings: true, template: true, slug: true, domain: true },
  });
}

async function loadRows(storeId: string, pageKey: string) {
  const [draft, published, head] = await Promise.all([
    prisma.storePageRevision.findFirst({
      where: { storeId, pageKey, status: 'draft' },
      select: { ...META_SELECT, document: true },
    }),
    prisma.storePageRevision.findFirst({
      where: { storeId, pageKey, status: 'published' },
      select: { ...META_SELECT, document: true },
    }),
    prisma.storePageRevision.aggregate({ where: { storeId, pageKey }, _max: { rev: true } }),
  ]);
  return {
    draft: draft as RevisionRow | null,
    published: published as RevisionRow | null,
    head: head._max.rev ?? 0,
  };
}

function resolvedLayout(store: { layoutSettings: unknown; template: string | null }) {
  return resolveLayoutSettings(
    store.layoutSettings ?? {},
    (store.template ?? undefined) as TemplateId | undefined
  );
}

export async function getPageState(storeId: string, pageKey: string): Promise<PageState | null> {
  const store = await loadStore(storeId);
  if (!store) return null;
  const { draft, published, head } = await loadRows(storeId, pageKey);
  const row = draft ?? published;
  return {
    rev: head,
    definition: row
      ? (row.document as PageDefinition)
      : layoutToDefinition(resolvedLayout(store), pageKey),
    source: draft ? 'draft' : published ? 'published' : 'layout',
    draftRev: draft?.rev ?? null,
    publishedRev: published?.rev ?? null,
  };
}

/**
 * The document the PUBLIC storefront renders: the published revision when it
 * is consistent with `layout_settings`, else the layout-derived document.
 * The consistency check is the guard against an out-of-band writer (a script
 * under packages/database/prisma) changing `layout_settings` behind a
 * published document: the storefront then follows `layout_settings`, which
 * is what every other reader sees, and the drift is logged.
 */
export async function getPublishedDefinition(
  storeId: string,
  layout: StoreLayoutSettings,
  pageKey = HOME_PAGE_KEY
): Promise<{ definition: PageDefinition; rev: number | null }> {
  // The public route may run with no tenant context (a storefront fetch by
  // path id carries no store header): enter the store's scope explicitly, or
  // strict RLS would return no row and every store would silently fall back.
  const published = await readInStoreContext(storeId, () =>
    prisma.storePageRevision.findFirst({
      where: { storeId, pageKey, status: 'published' },
      select: { rev: true, document: true },
    })
  );
  if (published) {
    const doc = published.document as unknown as PageDefinition;
    try {
      if (
        isDeepStrictEqual(
          JSON.parse(JSON.stringify(definitionToLayout(doc))),
          JSON.parse(JSON.stringify(layout))
        )
      )
        return { definition: doc, rev: published.rev };
    } catch {
      // fall through: an unreadable document renders from layout_settings
    }
    logger.warn(
      { storeId, pageKey, rev: published.rev },
      '[page-builder] published document disagrees with layout_settings; rendering from layout_settings'
    );
  }
  return { definition: layoutToDefinition(layout, pageKey), rev: published?.rev ?? null };
}

async function validateForWrite(storeId: string, input: unknown) {
  return validateDefinition(input, {
    resolveRefs: async ({ categorySlugs, productIds }) => {
      const [cats, prods] = await Promise.all([
        categorySlugs.length
          ? prisma.category.findMany({
              where: { storeId, slug: { in: categorySlugs } },
              select: { slug: true },
            })
          : Promise.resolve([]),
        productIds.length
          ? prisma.product.findMany({
              where: { storeId, id: { in: productIds } },
              select: { id: true },
            })
          : Promise.resolve([]),
      ]);
      return {
        categorySlugs: new Set(cats.map(c => c.slug)),
        productIds: new Set(prods.map(p => p.id)),
      };
    },
  });
}

async function conflict(
  storeId: string,
  pageKey: string,
  message: string
): Promise<ServiceResult<never>> {
  const latest = (await getPageState(storeId, pageKey)) ?? undefined;
  return { ok: false, status: 409, code: 'REV_CONFLICT', message, latest };
}

export async function saveDraft(args: {
  storeId: string;
  pageKey: string;
  baseRev: number;
  definition: unknown;
  userId: string | null;
}): Promise<ServiceResult<{ rev: number }>> {
  const { storeId, pageKey, baseRev, userId } = args;
  const store = await loadStore(storeId);
  if (!store) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Store not found' };
  const v = await validateForWrite(storeId, args.definition);
  if (!v.ok || !v.definition)
    return {
      ok: false,
      status: 422,
      code: 'INVALID_DEFINITION',
      message: 'The page document is invalid',
      errors: v.errors,
    };
  if (v.definition.pageKey !== pageKey)
    return {
      ok: false,
      status: 422,
      code: 'INVALID_DEFINITION',
      message: 'pageKey does not match the URL',
    };
  const definition = v.definition;

  const { draft, head } = await loadRows(storeId, pageKey);
  if (head !== baseRev)
    return conflict(
      storeId,
      pageKey,
      `The page changed (now rev ${head}); reload and re-apply your edit.`
    );
  const rev = head + 1;
  const data = {
    rev,
    document: definition as unknown as object,
    docBytes: docBytes(definition),
    schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
    baseRev,
    createdBy: userId,
  };
  try {
    await withSavepoint(async () => {
      if (draft) {
        // Guarded on the rev we read: a concurrent save/publish holding the
        // row lock changes it, the re-check matches 0 rows and we lose.
        const { count } = await prisma.storePageRevision.updateMany({
          where: { id: draft.id, storeId, rev: draft.rev, status: 'draft' },
          data,
        });
        if (count !== 1) throw new RevConflict();
      } else {
        await prisma.storePageRevision.create({
          data: { ...data, storeId, pageKey, status: 'draft' },
        });
      }
    });
  } catch (err) {
    if (err instanceof RevConflict || isP2002(err))
      return conflict(
        storeId,
        pageKey,
        'Another editor saved this page at the same time; reload and re-apply your edit.'
      );
    throw err;
  }
  return { ok: true, value: { rev }, warnings: v.warnings };
}

/** Promote `row` (or a fresh row) to published inside a savepoint; archive the old one. */
async function promote(
  storeId: string,
  pageKey: string,
  op: () => Promise<void>
): Promise<'ok' | 'conflict'> {
  try {
    await withSavepoint(async () => {
      await prisma.storePageRevision.updateMany({
        where: { storeId, pageKey, status: 'published' },
        data: { status: 'archived' },
      });
      await op();
    });
    return 'ok';
  } catch (err) {
    if (err instanceof RevConflict || isP2002(err)) return 'conflict';
    throw err;
  }
}

/**
 * Back-write `layout_settings` and queue every post-commit side effect:
 * the cache purge (all layers) and the R2 orphan cleanup.
 */
async function applyPublishedLayout(
  storeId: string,
  store: { layoutSettings: unknown; slug: string; domain: string | null },
  definition: PageDefinition
): Promise<StoreLayoutSettings> {
  const layout = definitionToLayout(definition);
  await prisma.store.update({
    where: { id: storeId },
    data: { layoutSettings: layout as unknown as object },
  });
  void cleanupRemovedJsonUrls(store.layoutSettings ?? {}, layout).catch(err =>
    logger.warn({ err, storeId }, '[page-builder] r2 cleanup failed')
  );
  purgePublishedCaches(storeId, store.slug, store.domain);
  return layout;
}

/** Exported for the purge-contract test. */
export function purgePublishedCaches(storeId: string, slug: string, domain: string | null): void {
  void deferAfterTenantCommit('page-builder.publish.purge', () =>
    bustStoreCaches(storeId, slug, domain)
  ).catch(err =>
    // Bounded staleness on failure: the storefront fetch revalidates in 60s.
    logger.error({ err, storeId }, '[page-builder] publish cache purge failed')
  );
}

export async function publishDraft(args: {
  storeId: string;
  pageKey: string;
  baseRev: number;
}): Promise<ServiceResult<{ rev: number; layout: StoreLayoutSettings }>> {
  const { storeId, pageKey, baseRev } = args;
  const store = await loadStore(storeId);
  if (!store) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Store not found' };
  const { draft, head } = await loadRows(storeId, pageKey);
  if (head !== baseRev)
    return conflict(
      storeId,
      pageKey,
      `The page changed (now rev ${head}); reload before publishing.`
    );
  if (!draft)
    return { ok: false, status: 409, code: 'NO_DRAFT', message: 'There is no draft to publish.' };
  const v = await validateForWrite(storeId, draft.document);
  if (!v.ok || !v.definition)
    return {
      ok: false,
      status: 422,
      code: 'INVALID_DEFINITION',
      message: 'The draft is invalid',
      errors: v.errors,
    };

  const outcome = await promote(storeId, pageKey, async () => {
    const { count } = await prisma.storePageRevision.updateMany({
      where: { id: draft.id, storeId, rev: baseRev, status: 'draft' },
      data: { status: 'published', publishedAt: new Date() },
    });
    if (count !== 1) throw new RevConflict();
  });
  if (outcome === 'conflict')
    return conflict(
      storeId,
      pageKey,
      'Another editor published or saved this page at the same time.'
    );
  const layout = await applyPublishedLayout(storeId, store, v.definition);
  return { ok: true, value: { rev: baseRev, layout }, warnings: v.warnings };
}

/**
 * Publish a NEW revision directly from a document (no draft involved):
 * rollback, and the legacy layout PUT. Any working draft is left in place;
 * its rev is now behind the head, so its next save/publish answers 409 and
 * the editor reloads — nothing is overwritten silently.
 */
async function publishNewRevision(args: {
  storeId: string;
  pageKey: string;
  definition: PageDefinition;
  baseRev: number;
  note: string;
  userId: string | null;
  archiveDraft: boolean;
}): Promise<'ok' | 'conflict'> {
  const { storeId, pageKey, definition } = args;
  const rev = args.baseRev + 1;
  return promote(storeId, pageKey, async () => {
    if (args.archiveDraft)
      await prisma.storePageRevision.updateMany({
        where: { storeId, pageKey, status: 'draft' },
        data: { status: 'archived', note: `superseded by rev ${rev}` },
      });
    await prisma.storePageRevision.create({
      data: {
        storeId,
        pageKey,
        rev,
        status: 'published',
        schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
        document: definition as unknown as object,
        docBytes: docBytes(definition),
        baseRev: args.baseRev,
        note: args.note,
        createdBy: args.userId,
        publishedAt: new Date(),
      },
    });
  });
}

export async function rollbackToRevision(args: {
  storeId: string;
  pageKey: string;
  targetRev: number;
  baseRev: number;
  userId: string | null;
}): Promise<
  ServiceResult<{ rev: number; discardedDraftRev: number | null; layout: StoreLayoutSettings }>
> {
  const { storeId, pageKey, targetRev, baseRev } = args;
  const store = await loadStore(storeId);
  if (!store) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Store not found' };
  const { draft, head } = await loadRows(storeId, pageKey);
  if (head !== baseRev)
    return conflict(
      storeId,
      pageKey,
      `The page changed (now rev ${head}); reload before rolling back.`
    );
  const target = await prisma.storePageRevision.findFirst({
    where: { storeId, pageKey, rev: targetRev, status: { in: ['published', 'archived'] } },
    select: { document: true },
  });
  if (!target)
    return {
      ok: false,
      status: 404,
      code: 'REVISION_NOT_FOUND',
      message: `No published revision ${targetRev}`,
    };
  // Re-validate: an archived document may predate a registry change.
  const v = await validateForWrite(storeId, target.document);
  if (!v.ok || !v.definition)
    return {
      ok: false,
      status: 422,
      code: 'INVALID_DEFINITION',
      message: 'That revision no longer validates',
      errors: v.errors,
    };
  const outcome = await publishNewRevision({
    storeId,
    pageKey,
    definition: v.definition,
    baseRev,
    note: `rollback to rev ${targetRev}`,
    userId: args.userId,
    // The caller saw the head (incl. any draft) — rolling back supersedes it, and says so.
    archiveDraft: true,
  });
  if (outcome === 'conflict')
    return conflict(storeId, pageKey, 'Another editor changed this page at the same time.');
  const layout = await applyPublishedLayout(storeId, store, v.definition);
  return { ok: true, value: { rev: baseRev + 1, discardedDraftRev: draft?.rev ?? null, layout } };
}

/**
 * The legacy `PUT /admin/stores/:id/layout` path. It keeps its contract
 * (patch merge, no rev) but its write becomes a published revision, so the
 * revision history and `layout_settings` never diverge. Returns 'conflict'
 * only when it lost a race with a concurrent publish (the caller answers 409).
 */
export async function publishLegacyLayout(args: {
  storeId: string;
  layout: StoreLayoutSettings;
  userId: string | null;
}): Promise<'ok' | 'conflict'> {
  const { storeId, layout } = args;
  const definition = layoutToDefinition(layout, HOME_PAGE_KEY);
  const { head } = await loadRows(storeId, HOME_PAGE_KEY);
  return publishNewRevision({
    storeId,
    pageKey: HOME_PAGE_KEY,
    definition,
    baseRev: head,
    note: 'saved through the legacy layout endpoint',
    userId: args.userId,
    archiveDraft: false,
  });
}

export async function listRevisions(args: {
  storeId: string;
  pageKey: string;
  cursor?: number;
  limit: number;
}) {
  const limit = Math.min(Math.max(args.limit, 1), 50);
  const rows = await prisma.storePageRevision.findMany({
    where: {
      storeId: args.storeId,
      pageKey: args.pageKey,
      ...(args.cursor !== undefined ? { rev: { lt: args.cursor } } : {}),
    },
    orderBy: { rev: 'desc' },
    take: limit + 1,
    select: META_SELECT,
  });
  const page = rows.slice(0, limit);
  return {
    revisions: page,
    nextCursor: rows.length > limit ? page[page.length - 1].rev : null,
  };
}

export { BUILDER_LIMITS };
