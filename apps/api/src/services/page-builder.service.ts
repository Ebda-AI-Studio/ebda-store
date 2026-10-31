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
 * Theme (Ruling THEME-DRAFT-1): the editor's global theme edits are a PATCH
 * in the document (`PageDefinition.theme`, packages/shared theme-draft.ts), so
 * they follow the same lifecycle. A draft save never touches `stores.theme`;
 * publish / rollback merge the patch over it inside the SAME `stores` update as
 * the `layout_settings` back-write (one statement: atomic) and the same
 * post-commit purge covers it. A published revision records a full snapshot of
 * the editor-managed keys so rollback restores them; a revision without `theme`
 * (anything published before this change, the legacy layout PUT) leaves the
 * live theme alone. The published theme is never part of what the editor
 * re-opens (`getPageState` strips it) — only a pending draft patch is.
 *
 * Caches (bounded-stale class: layout/content): a publish/rollback purges
 * every layer through `bustStoreCaches` AFTER the commit
 * (`deferAfterTenantCommit`) — Redis `public:store:*` (+ generation bump),
 * the storefront Next data cache via the `layout:<storeId>` tag, and the
 * store's slug/host/domain resolve keys. Draft saves touch no public cache.
 */
import { storeDb, storeRepo, storeUpdate, storeWriter } from '../lib/repo-factory';
import { isDeepStrictEqual } from 'node:util';
import { prisma, withStore } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import {
  BUILDER_LIMITS,
  PAGE_DEFINITION_SCHEMA_VERSION,
  definitionToLayout,
  layoutToDefinition,
  mergeDocumentOnlySections,
  publishedDocumentAgrees,
  resolveLayoutSettings,
  snapshotEditableTheme,
  applyThemePatch,
  applyTypographyPatch,
  hasTypographyPatch,
  snapshotTypography,
  applyChromePatch,
  applyTemplateFamily,
  NEW_STORE_LAYOUT_SETTINGS,
  hasChromePatch,
  pageDefinitionSchema,
  rebaseDraftOntoLive,
  validateDefinition,
  validatePublishReadiness,
  type BuilderIssue,
  type PageDefinition,
  type StoreLayoutSettings,
  type TemplateFamily,
  type TemplateId,
  getLook,
  normalizeLegacyTemplate,
  PAGE_KINDS,
  diffTemplateFamily,
  PAGE_OWNED_SETTING_KEYS,
  ALL_PAGE_OWNED_KEYS,
  pickOwnedSettings,
  defaultPageDocument,
  isSectionPageKind,
  validateDefinitionSync,
  type SectionPageKind,
} from '@ebda/shared';
import { withSavepoint } from '../lib/savepoint';
import { fontLibraryProblems } from '../lib/font-url-guard';
import { readInStoreContext } from '../lib/store-scoped-read';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { bustStoreCaches } from './store.service';
import { cleanupRemovedJsonUrls, deleteR2ObjectIfOrphan } from './r2-cleanup.service';
import logger from '../lib/logger';

export const HOME_PAGE_KEY = 'home';
/** The page documents the builder edits (home plus the product / collection / cart section pages). */
export const BUILDER_PAGE_KEYS: ReadonlySet<string> = new Set(PAGE_KINDS);

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
  publishedBy: string | null;
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
  publishedBy: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
} as const;

const docBytes = (d: unknown) => Buffer.byteLength(JSON.stringify(d), 'utf8');

async function loadStore(storeId: string) {
  return withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: {
        layoutSettings: true,
        template: true,
        look: true,
        slug: true,
        domain: true,
        theme: true,
        typography: true,
      },
    })
  );
}

/**
 * The document a page has before anyone saved one: the home page is derived from `layout_settings`
 * through the adapter; a product / collection / cart page is its default section document (Ruling
 * VE-3 amended): the order the storefront already renders, so nothing is migrated.
 */
/** The home document with the keys other pages own taken from the live layout. */
function overlayOwnedSettings(doc: PageDefinition, live: Record<string, unknown>): PageDefinition {
  const siteSettings = { ...doc.siteSettings };
  for (const k of ALL_PAGE_OWNED_KEYS) {
    if (live[k] !== undefined) siteSettings[k] = live[k];
    else delete siteSettings[k];
  }
  return { ...doc, siteSettings };
}

function fallbackDefinition(
  store: { layoutSettings: unknown; template: string | null; look?: string | null },
  pageKey: string
): PageDefinition {
  if (isSectionPageKind(pageKey))
    return defaultPageDocument(pageKey, (store.layoutSettings ?? {}) as Record<string, unknown>);
  return layoutToDefinition(resolvedLayout(store), pageKey);
}

/** MAX(rev) of a page. Postgres keeps the aggregate; the Durable Object client has no `aggregate`, so it reads the newest row. */
async function maxRev(storeId: string, pageKey: string): Promise<number> {
  const repo = await storeRepo(storeId);
  if (repo.backend === 'pg') {
    const a = await (
      await storeDb(storeId)
    ).storePageRevision.aggregate({
      where: { storeId, pageKey },
      _max: { rev: true },
    });
    return a._max.rev ?? 0;
  }
  const newest = await repo.writer.storePageRevision.findFirst({
    where: { storeId, pageKey },
    orderBy: { rev: 'desc' },
    select: { rev: true },
  });
  return newest?.rev ?? 0;
}

async function loadRows(storeId: string, pageKey: string) {
  const [draft, published, head] = await Promise.all([
    (await storeWriter(storeId)).storePageRevision.findFirst({
      where: { storeId, pageKey, status: 'draft' },
      select: { ...META_SELECT, document: true },
    }),
    (await storeWriter(storeId)).storePageRevision.findFirst({
      where: { storeId, pageKey, status: 'published' },
      select: { ...META_SELECT, document: true },
    }),
    maxRev(storeId, pageKey),
  ]);
  return {
    draft: draft as RevisionRow | null,
    published: published as RevisionRow | null,
    head,
  };
}

function resolvedLayout(store: {
  layoutSettings: unknown;
  template: string | null;
  look?: string | null;
}) {
  return resolveLayoutSettings(
    store.layoutSettings ?? {},
    store.template ? normalizeLegacyTemplate(store.template) : undefined,
    store.look
  );
}

/**
 * A published document's `theme` snapshot is already live (`stores.theme`), so
 * the editor must not re-open it as a pending edit: a stale snapshot sent back
 * in the next draft would overwrite later live changes to those keys.
 */
function withoutTheme(document: unknown): PageDefinition {
  const rest = { ...(document as PageDefinition) };
  delete rest.theme;
  // Typography (fonts + zones) is the same story: once published it is live in `stores.typography`.
  delete rest.typography;
  // Same for the header/footer content patch (`chrome`): once published it is
  // live in `stores.settings`, so it is not re-opened as a pending edit.
  delete rest.chrome;
  return rest;
}

export async function getPageState(storeId: string, pageKey: string): Promise<PageState | null> {
  const store = await loadStore(storeId);
  if (!store) return null;
  const { draft, published, head } = await loadRows(storeId, pageKey);
  const live = (store.layoutSettings ?? {}) as Record<string, unknown>;
  // what the storefront resolves (template defaults filled in), for the home page's copy of other pages' keys
  const resolved = resolvedLayout(store) as unknown as Record<string, unknown>;
  const base = draft
    ? (draft.document as PageDefinition)
    : published
      ? withoutTheme(published.document)
      : fallbackDefinition(store, pageKey);
  // The page opens on what the storefront shows: a section page's own settings come from the live
  // layout (a draft keeps its own, it is the edit in progress), and home never shows a stale copy of them.
  const definition =
    isSectionPageKind(pageKey) && !draft
      ? { ...base, siteSettings: pickOwnedSettings(pageKey, live) }
      : !isSectionPageKind(pageKey)
        ? overlayOwnedSettings(base, resolved)
        : base;
  return {
    rev: head,
    definition,
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
 *
 * `layout` is the row resolved against `templateId` (what the route serves),
 * so the document side must be resolved the same way (`publishedDocumentAgrees`)
 * — comparing the template-less projection made every template family and
 * every removed section look like drift (Ruling BUILDER-PUBLISH-1).
 */
export async function getPublishedDefinition(
  storeId: string,
  layout: StoreLayoutSettings,
  templateId: TemplateId | null,
  pageKey = HOME_PAGE_KEY,
  /** The store's look, so the document side resolves like `layout` did (LOOKS-15). */
  look: string | null = null
): Promise<{ definition: PageDefinition; rev: number | null }> {
  // The public route may run with no tenant context (a storefront fetch by
  // path id carries no store header): enter the store's scope explicitly, or
  // strict RLS would return no row and every store would silently fall back.
  const published = await readInStoreContext(storeId, async () =>
    (await storeWriter(storeId)).storePageRevision.findFirst({
      where: { storeId, pageKey, status: 'published' },
      select: { rev: true, document: true },
    })
  );
  if (isSectionPageKind(pageKey)) return publishedPageDocument(pageKey, published);
  if (published) {
    const doc = published.document as unknown as PageDefinition;
    try {
      if (publishedDocumentAgrees(doc, layout, templateId ?? undefined, look))
        return {
          // other pages' settings are read from the live layout, never from this document's copy
          definition: overlayOwnedSettings(doc, layout as unknown as Record<string, unknown>),
          rev: published.rev,
        };
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

/**
 * A section page (product / collection / cart) has no `layout_settings` projection to disagree with, so
 * its published document is served as it is, once it still validates; an unreadable or stale one falls
 * back to the default document rather than breaking the page.
 */
function publishedPageDocument(
  pageKey: SectionPageKind,
  published: { rev: number; document: unknown } | null
): { definition: PageDefinition; rev: number | null } {
  if (published) {
    const check = validateDefinitionSync(published.document);
    if (check.ok) return { definition: published.document as PageDefinition, rev: published.rev };
    logger.warn(
      { pageKey, rev: published.rev },
      '[page-builder] published page document no longer validates; rendering the default document'
    );
  }
  return { definition: defaultPageDocument(pageKey), rev: published?.rev ?? null };
}

/** The PUBLISHED document of a product / collection / cart page (the default one when none is saved). */
export async function getPublishedPageDocument(
  storeId: string,
  kind: SectionPageKind
): Promise<{ definition: PageDefinition; rev: number | null }> {
  const published = await readInStoreContext(storeId, async () =>
    (await storeWriter(storeId)).storePageRevision.findFirst({
      where: { storeId, pageKey: kind, status: 'published' },
      select: { rev: true, document: true },
    })
  );
  return publishedPageDocument(kind, published);
}

async function validateForWrite(storeId: string, input: unknown) {
  const result = await validateDefinitionRefs(storeId, input);
  // A font URL is merchant-supplied and later drives an R2 delete: it must be this store's own file
  // or an allowlisted Google stylesheet (checked on every draft save, publish and rollback).
  if (result.definition?.typography?.fonts) {
    const bad = fontLibraryProblems(storeId, result.definition.typography.fonts);
    if (bad.length > 0)
      return {
        ...result,
        ok: false,
        errors: [
          ...result.errors,
          ...bad.map(b => ({
            code: 'SCHEMA' as const,
            path: `/typography/fonts/${b.index}/url`,
            messageEn: b.reason,
            messageAr: 'رابط الخط لازم يكون لملف مرفوع على متجرك أو لخط من Google.',
          })),
        ],
      };
  }
  return result;
}

function validateDefinitionRefs(storeId: string, input: unknown) {
  return validateDefinition(input, {
    resolveRefs: async ({ categorySlugs, productIds }) => {
      const [cats, prods] = await Promise.all([
        categorySlugs.length
          ? (await storeWriter(storeId)).category.findMany({
              where: { storeId, slug: { in: categorySlugs } },
              select: { slug: true },
            })
          : Promise.resolve([]),
        productIds.length
          ? (await storeWriter(storeId)).product.findMany({
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
        const { count } = await (
          await storeWriter(storeId)
        ).storePageRevision.updateMany({
          where: { id: draft.id, storeId, rev: draft.rev, status: 'draft' },
          data,
        });
        if (count !== 1) throw new RevConflict();
      } else {
        await (
          await storeWriter(storeId)
        ).storePageRevision.create({
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

/**
 * Extra columns for the row publish promotes: when the draft carries a theme
 * patch, the published document records a full snapshot of the editor-managed
 * keys (live ⊕ patch) so rolling back to it restores exactly those keys.
 */
function publishedThemeData(
  document: unknown,
  liveTheme: unknown,
  liveTypography: unknown
): Record<string, unknown> {
  const doc = document as PageDefinition;
  const typography = hasTypographyPatch(doc.typography) ? doc.typography : undefined;
  if (!doc.theme && !typography) return {};
  const snapshotted = {
    ...doc,
    ...(doc.theme
      ? { theme: snapshotEditableTheme(liveTheme as Record<string, unknown> | null, doc.theme) }
      : {}),
    // Rollback restores the whole library + zones as they were once this revision went live.
    ...(typography ? { typography: snapshotTypography(liveTypography, typography) } : {}),
  };
  return { document: snapshotted as unknown as object, docBytes: docBytes(snapshotted) };
}

/**
 * Who published/restored a revision is recorded as the user ID only (`published_by`, pseudonymised with
 * the user on offboarding, OFFBOARD-1). The NAME is never copied onto the revision: history resolves it at
 * read time (`publisherNames`), so an erased user's name cannot linger in page history.
 */
function publisherStamp(userId: string | null): { publishedBy: string | null } {
  return { publishedBy: userId };
}

/**
 * Names for the publishers on one page of history, read live. Under strict RLS only the store's owner and
 * its staff are visible to the acting user, which is exactly who can publish. A user who is gone, soft
 * deleted or erased resolves to nothing, and the UI then says "Removed user".
 */
async function publisherNames(storeId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const fullName = (u: { firstName: string; lastName: string; deletedAt: Date | null }) =>
    u.deletedAt ? '' : `${u.firstName} ${u.lastName}`.trim();
  const select = { firstName: true, lastName: true, deletedAt: true } as const;
  try {
    const [staff, store] = await Promise.all([
      prisma.storeStaff.findMany({
        where: { storeId, userId: { in: ids } },
        select: { userId: true, user: { select } },
      }),
      prisma.store.findUnique({
        where: { id: storeId },
        select: { ownerId: true, owner: { select } },
      }),
    ]);
    for (const m of staff) {
      const n = fullName(m.user);
      if (n) out.set(m.userId, n);
    }
    if (store && ids.includes(store.ownerId)) {
      const n = fullName(store.owner);
      if (n) out.set(store.ownerId, n);
    }
  } catch {
    // history must still load; unresolved names show as "Removed user"
  }
  return out;
}

/** Promote `row` (or a fresh row) to published inside a savepoint; archive the old one. */
async function promote(
  storeId: string,
  pageKey: string,
  op: () => Promise<void>
): Promise<'ok' | 'conflict'> {
  try {
    await withSavepoint(async () => {
      await (
        await storeWriter(storeId)
      ).storePageRevision.updateMany({
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
  store: {
    layoutSettings: unknown;
    template: string | null;
    look: string | null;
    slug: string;
    domain: string | null;
  },
  definition: PageDefinition
): Promise<StoreLayoutSettings> {
  // A product / collection / cart document is not a projection of `layout_settings`: publishing it
  // writes exactly the layout keys that page owns (Ruling VE-13) and nothing else, then purges the caches.
  if (isSectionPageKind(definition.pageKey)) {
    const owned = PAGE_OWNED_SETTING_KEYS[definition.pageKey];
    const next = await withStore(storeId, async tx => {
      const row = await tx.store.findUnique({
        where: { id: storeId },
        select: { layoutSettings: true },
      });
      const current = (row?.layoutSettings ?? {}) as Record<string, unknown>;
      const merged = { ...current };
      for (const k of owned) {
        const v = definition.siteSettings[k];
        if (v === undefined) delete merged[k];
        else merged[k] = v;
      }
      // a reorder or a hidden section changes no layout key: leave the store row alone
      if (!isDeepStrictEqual(merged, current))
        await storeUpdate(tx, {
          where: { id: storeId },
          data: { layoutSettings: merged as object },
        });
      return merged;
    });
    purgePublishedCaches(storeId, store.slug, store.domain);
    return resolvedLayout({ ...store, layoutSettings: next });
  }
  const layout = definitionToLayout(definition) as unknown as Record<string, unknown>;
  let removedUrlsBase: unknown = store.layoutSettings ?? {};
  const themePatch = definition.theme;
  const typographyPatch = hasTypographyPatch(definition.typography)
    ? definition.typography
    : undefined;
  const chromePatch = hasChromePatch(definition.chrome) ? definition.chrome : undefined;
  let removedFontUrls: string[] = [];
  await withStore(storeId, async tx => {
    // Merge the pending theme / typography / header+footer content over the CURRENT live
    // values read in this same transaction (the Branding tab and the classic
    // builder also write other theme / settings keys), and write them with
    // layout_settings in one statement.
    const live = await tx.store.findUnique({
      where: { id: storeId },
      select: { theme: true, typography: true, settings: true, layoutSettings: true },
    });
    // The keys a product / collection / cart page owns are written only by that page's publish: the
    // home document keeps the LIVE value (read in this same transaction), whatever its copy says.
    const liveLayout = (live?.layoutSettings ?? {}) as Record<string, unknown>;
    for (const k of ALL_PAGE_OWNED_KEYS) {
      if (liveLayout[k] !== undefined) layout[k] = liveLayout[k];
      else delete layout[k];
    }
    removedUrlsBase = liveLayout;
    const nextTypography = typographyPatch
      ? applyTypographyPatch(live?.typography, typographyPatch)
      : undefined;
    if (nextTypography) {
      // A custom font that left the library is deleted from R2 once nothing else references it.
      const kept = new Set(nextTypography.fonts.filter(f => f.type === 'custom').map(f => f.url));
      const before = (live?.typography as { fonts?: Array<{ type: string; url?: string }> } | null)
        ?.fonts;
      removedFontUrls = (Array.isArray(before) ? before : [])
        .filter(f => f.type === 'custom' && f.url && !kept.has(f.url))
        .map(f => f.url as string);
    }
    return storeUpdate(tx, {
      where: { id: storeId },
      data: {
        layoutSettings: layout as unknown as object,
        ...(themePatch
          ? { theme: applyThemePatch((live?.theme ?? {}) as object, themePatch) as object }
          : {}),
        ...(nextTypography ? { typography: nextTypography as unknown as object } : {}),
        ...(chromePatch
          ? { settings: applyChromePatch(live?.settings, chromePatch) as unknown as object }
          : {}),
      },
    });
  });
  for (const url of removedFontUrls)
    void deleteR2ObjectIfOrphan(url).catch(err =>
      logger.warn({ err, storeId, url }, '[page-builder] font r2 cleanup failed')
    );
  void cleanupRemovedJsonUrls(removedUrlsBase, layout).catch(err =>
    logger.warn({ err, storeId }, '[page-builder] r2 cleanup failed')
  );
  purgePublishedCaches(storeId, store.slug, store.domain);
  return layout as unknown as StoreLayoutSettings;
}

/** Exported for the purge-contract test. */
/**
 * Staleness class: NEVER-stale. Page content must be what the merchant just published, so the purge is
 * EVENT invalidation on every publish path (publish, rollback, the legacy layout PUT, look apply) and
 * clears every layer `bustStoreCaches` owns (Redis, in-memory, the `layout:<storeId>` Next tag). The
 * storefront's 60 s revalidate is only a backstop, never the mechanism: a failed purge is therefore
 * retried (3 attempts, short backoff) and, if it still fails, raised as an error log for alerting.
 */
const PURGE_ATTEMPTS = 3;
export function purgePublishedCaches(storeId: string, slug: string, domain: string | null): void {
  void deferAfterTenantCommit('page-builder.publish.purge', async () => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= PURGE_ATTEMPTS; attempt++) {
      try {
        await bustStoreCaches(storeId, slug, domain);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < PURGE_ATTEMPTS) await new Promise(r => setTimeout(r, 200 * attempt));
      }
    }
    throw lastErr;
  }).catch(err =>
    logger.error({ err, storeId }, '[page-builder] publish cache purge failed after retries')
  );
}

export async function publishDraft(args: {
  storeId: string;
  pageKey: string;
  baseRev: number;
  userId?: string | null;
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
  // Structurally valid is not publish-ready: a draft may still hold a hero
  // slide with no image chosen yet (allowed so autosave can persist it), or
  // starter/placeholder text ("Tell customers what makes your products
  // special.") that must never go live (PLACEHOLDER_COPY).
  const readinessErrors = validatePublishReadiness(v.definition);
  if (readinessErrors.length > 0)
    return {
      ok: false,
      status: 422,
      code: 'INVALID_DEFINITION',
      message: 'The draft is not ready to publish',
      errors: readinessErrors,
    };

  const stamp = publisherStamp(args.userId ?? null);
  const outcome = await promote(storeId, pageKey, async () => {
    const { count } = await (
      await storeWriter(storeId)
    ).storePageRevision.updateMany({
      where: { id: draft.id, storeId, rev: baseRev, status: 'draft' },
      data: {
        status: 'published',
        publishedAt: new Date(),
        ...stamp,
        ...publishedThemeData(draft.document, store.theme, store.typography),
      },
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
  /** Runs in the same savepoint right after the published row is created. */
  afterCreate?: (publishedRev: number) => Promise<void>;
}): Promise<'ok' | 'conflict'> {
  const { storeId, pageKey, definition } = args;
  const rev = args.baseRev + 1;
  const stamp = publisherStamp(args.userId);
  return promote(storeId, pageKey, async () => {
    if (args.archiveDraft)
      await (
        await storeWriter(storeId)
      ).storePageRevision.updateMany({
        where: { storeId, pageKey, status: 'draft' },
        data: { status: 'archived', note: `superseded by rev ${rev}` },
      });
    await (
      await storeWriter(storeId)
    ).storePageRevision.create({
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
        ...stamp,
      },
    });
    await args.afterCreate?.(rev);
  });
}

/** A store whose `layout_settings` still holds nothing a merchant wrote (new-store seed or empty). */
function isUntouchedLayout(layout: unknown): boolean {
  if (layout == null) return true;
  if (typeof layout !== 'object') return false;
  if (Object.keys(layout).length === 0) return true;
  return isDeepStrictEqual(layout, NEW_STORE_LAYOUT_SETTINGS);
}

/**
 * Remove the top-level sections that fail `validatePublishReadiness` (placeholder copy, a hero slide
 * with no image). Issue paths look like `/sections/<i>/...`; anything not attributable to a
 * top-level section is left alone, and publish will still refuse it (the caller then stays a draft).
 */
function dropUnpublishableSections(definition: PageDefinition): PageDefinition {
  const bad = new Set<number>();
  for (const issue of validatePublishReadiness(definition)) {
    const m = /^\/sections\/(\d+)(?:\/|$)/.exec(issue.path);
    if (m) bad.add(Number(m[1]));
  }
  if (bad.size === 0) return definition;
  return { ...definition, sections: definition.sections.filter((_, i) => !bad.has(i)) };
}

/**
 * Re-shape the home page to a look's template family without losing content
 * (`applyTemplateFamily` keeps every existing section of a family type and only
 * adds the missing ones; sections outside the family are dropped from the new
 * document; a look with its own section mix supplies the order, its design keys and
 * the presets of added sections instead, Ruling B1-3). Runs in the CALLER's tenant scope, like the builder routes: it only
 * composes `saveDraft` / `publishDraft`, which scope themselves.
 *
 * - genuinely fresh store (no revision, no draft, `layout_settings` empty or the
 *   new-store seed): published, so it looks like its look immediately;
 * - EVERYTHING else (a published page, an in-progress draft, or a legacy store
 *   whose customised `layout_settings` never went through the builder): a DRAFT
 *   only. Publishing would replace `layout_settings` wholesale and delete the
 *   R2 images the new document no longer references (Ruling LOOKS-8).
 * `resetThemeKeys` are stripped from the document's pending theme patch so a
 * later publish cannot re-apply keys the merchant just reset.
 */
async function composeLookDocument(
  storeId: string,
  family: TemplateFamily['id'],
  resetThemeKeys: readonly string[] = [],
  /** The look being applied. The store row still holds the OLD look/template here (the builder
   *  step runs first), so a layout-derived page is re-derived for the new skin + look: the look
   *  owns the default card image ratio, and the old skin's card shape must not be baked into
   *  the new document (Ruling LOOKS-15). */
  lookId: string | null = null,
  /** The switch's design choice (TPL-1): `keep` leaves every section design field the merchant
   *  changed from the outgoing look's mix; `reset` applies the incoming look's design whole. */
  design: 'keep' | 'reset' = 'reset',
  revisionToken?: string
): Promise<{
  state: PageState;
  definition: PageDefinition;
  fresh: boolean;
  store: NonNullable<Awaited<ReturnType<typeof loadStore>>>;
}> {
  const state = await getPageState(storeId, HOME_PAGE_KEY);
  if (!state) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  const store = await loadStore(storeId);
  if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  if (revisionToken !== undefined && revisionToken !== lookRevisionToken(state, store))
    throw new AppError(409, 'DRAFT_MOVED', 'The page changed since the preview; preview again.');
  const look = getLook(lookId);
  const start =
    state.source === 'layout' && look
      ? layoutToDefinition(
          resolveLayoutSettings(store.layoutSettings ?? {}, look.skin, look.id),
          HOME_PAGE_KEY
        )
      : state.definition;
  // The OUTGOING look is the one that composed this document (`appliedLook`), else the store
  // row's (it still holds the old look here). After a discarded draft the published document is
  // the right baseline, not the store row (C6/C8).
  const outgoingId = state.definition.appliedLook ?? store.look;
  const outgoing = getLook(outgoingId);
  // The skin baseline the start document's layout-backed sections hold: a layout-derived page was
  // just re-derived for the INCOMING skin + look above; a stored document was composed on the
  // store's skin (when its look is the store's) or on the outgoing look's skin.
  const toSkin = look ? { skin: look.skin, look: look.id } : undefined;
  const fromSkin =
    start !== state.definition && toSkin
      ? toSkin
      : {
          skin:
            outgoing && outgoingId !== store.look
              ? outgoing.skin
              : normalizeLegacyTemplate(store.template),
          look: outgoing?.id ?? null,
        };
  let definition = applyTemplateFamily(start, family, look, {
    from: outgoing,
    design,
    fromSkin,
    ...(toSkin ? { toSkin } : {}),
  });
  if (look) definition = { ...definition, appliedLook: look.id };
  if (definition.theme && resetThemeKeys.length > 0) {
    const theme = { ...definition.theme } as Record<string, unknown>;
    for (const k of resetThemeKeys) delete theme[k];
    const next = { ...definition } as PageDefinition & { theme?: unknown };
    if (Object.keys(theme).length > 0) next.theme = theme as PageDefinition['theme'];
    else delete next.theme;
    definition = next;
  }
  let fresh = state.source === 'layout' && isUntouchedLayout(store.layoutSettings);
  // A genuinely fresh store has no content to lose, so sections that still hold starter copy or a
  // missing image (and would block the publish) are dropped, and the rest goes live. A store with
  // content never reaches this: it keeps the draft path below, untouched.
  if (fresh) {
    const publishable = dropUnpublishableSections(definition);
    if (publishable.sections.length > 0) {
      definition = publishable;
    } else {
      // Every section would be dropped: publishing would put an EMPTY home live. Keep the whole
      // family as a draft instead so the merchant fills it in the editor (Ruling LOOKS-9).
      logger.warn(
        { storeId, family },
        '[page-builder] look family left as a draft: no section is publishable yet'
      );
      fresh = false;
    }
  }
  return { state, definition, fresh, store };
}

/**
 * An opaque token for everything a look switch reads: the revision head, the document it starts
 * from (a layout-derived page has no revision rows), and the store's layout, theme, look and
 * template. A preview carries it and the apply refuses (DRAFT_MOVED) when any of it moved.
 */
export function lookRevisionToken(
  state: Pick<PageState, 'rev' | 'draftRev' | 'publishedRev' | 'definition' | 'source'>,
  store: { layoutSettings?: unknown; theme?: unknown; look?: unknown; template?: unknown }
): string {
  const text = JSON.stringify([
    state.source,
    state.definition,
    store.layoutSettings ?? null,
    store.theme ?? null,
    store.look ?? null,
    store.template ?? null,
  ]);
  let h = 0x811c9dc5; // FNV-1a, 32 bit: a change detector, not a security boundary
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `r${state.rev}d${state.draftRev ?? 0}p${state.publishedRev ?? 0}h${h.toString(36)}`;
}

/**
 * The document a look switch would write, and what it changes (Task 9): nothing is saved. The apply
 * recomputes the same document from the current draft, so a preview can never differ from it.
 */
export async function previewFamilyForLook(
  storeId: string,
  family: TemplateFamily['id'],
  resetThemeKeys: readonly string[],
  lookId: string,
  design: 'keep' | 'reset'
) {
  const { state, definition, fresh, store } = await composeLookDocument(
    storeId,
    family,
    resetThemeKeys,
    lookId,
    design
  );
  const live = (store.theme ?? {}) as Record<string, unknown>;
  const pending = (state.definition.theme ?? {}) as Record<string, unknown>;
  const report = diffTemplateFamily(
    state.definition,
    definition,
    resetThemeKeys.filter(k => k in live || k in pending)
  );
  return {
    draft: definition,
    report,
    revisionToken: lookRevisionToken(state, store),
    willPublish: fresh,
  };
}

export async function applyFamilyForLook(
  storeId: string,
  family: TemplateFamily['id'],
  userId: string | null = null,
  resetThemeKeys: readonly string[] = [],
  lookId: string | null = null,
  design: 'keep' | 'reset' = 'reset',
  /** From a preview: refuse (409 DRAFT_MOVED) when the page changed since it was computed. */
  revisionToken?: string
): Promise<'published' | 'draft'> {
  const { state, definition, fresh } = await composeLookDocument(
    storeId,
    family,
    resetThemeKeys,
    lookId,
    design,
    revisionToken
  );
  const saved = await saveDraft({
    storeId,
    pageKey: HOME_PAGE_KEY,
    baseRev: state.rev,
    definition,
    userId,
  });
  if (!saved.ok) throw new AppError(saved.status, saved.code, saved.message);
  if (!fresh) return 'draft';
  const published = await publishDraft({
    storeId,
    pageKey: HOME_PAGE_KEY,
    baseRev: saved.value.rev,
  });
  if (!published.ok) {
    logger.warn(
      { storeId, code: published.code, message: published.message },
      '[page-builder] look family left as a draft: publish refused'
    );
    return 'draft';
  }
  return 'published';
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
  const target = await (
    await storeWriter(storeId)
  ).storePageRevision.findFirst({
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
  // This is a THIRD publish path (alongside publishDraft and
  // publishLegacyLayout) — a revision from before validatePublishReadiness
  // existed (or any archived one) can still hold a hero slide with no
  // image. Without this check, rolling back to it republishes it live and
  // reintroduces the exact defect those two paths were gated against.
  const readinessErrors = validatePublishReadiness(v.definition);
  if (readinessErrors.length > 0)
    return {
      ok: false,
      status: 422,
      code: 'INVALID_DEFINITION',
      message: 'That revision is not ready to publish',
      errors: readinessErrors,
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
 * only when it lost a race with a concurrent publish (the caller answers 409),
 * or 'invalid' when the merged document isn't publish-ready (e.g. a hero
 * slide with no image — this path has no separate draft state, so it must
 * refuse rather than publish an incomplete slide; the caller answers 422).
 */
export async function publishLegacyLayout(args: {
  storeId: string;
  layout: StoreLayoutSettings;
  userId: string | null;
}): Promise<'ok' | 'conflict' | { invalid: BuilderIssue[] }> {
  const { storeId, layout } = args;
  const { head, draft, published } = await loadRows(storeId, HOME_PAGE_KEY);
  // The layout knows nothing about document-only sections (image-text,
  // newsletter): carry them over from the LIVE document or this save would
  // delete them. Never from the draft: a section that only exists in an
  // unpublished draft must not go live through this path.
  const previous = published?.document as PageDefinition | undefined;
  const definition = mergeDocumentOnlySections(layoutToDefinition(layout, HOME_PAGE_KEY), previous);
  // Placeholder-copy check OFF here, deliberately: this legacy PUT cannot
  // author document-only section text (it only carries those sections over
  // unchanged from the previous document), so gating it would 422 an
  // unrelated theme/layout save for a store whose existing page still holds
  // starter copy. The copy is gated where it is authored: publishDraft and
  // rollbackToRevision. (Ruling PLACEHOLDER-1.)
  const readinessErrors = validatePublishReadiness(definition, { placeholderCopy: false });
  if (readinessErrors.length > 0) return { invalid: readinessErrors };

  // A pending visual draft is MERGED with what this save changed instead of
  // being left stale (the next Publish of it would silently revert this save)
  // or discarded (Ruling CLASSIC-SAVE-DRAFT-1).
  let rebased: PageDefinition | null = null;
  if (draft) {
    const store = await loadStore(storeId);
    const previousLive = published
      ? withoutTheme(published.document)
      : layoutToDefinition(
          resolvedLayout(store ?? { layoutSettings: {}, template: null }),
          HOME_PAGE_KEY
        );
    const candidate = rebaseDraftOntoLive(
      draft.document as PageDefinition,
      previousLive,
      definition
    );
    const parsed = pageDefinitionSchema.safeParse(candidate);
    if (parsed.success) rebased = parsed.data;
    else
      logger.warn(
        { storeId },
        '[page-builder] classic save could not be merged into the pending draft; draft kept as is'
      );
  }
  return publishNewRevision({
    storeId,
    pageKey: HOME_PAGE_KEY,
    definition,
    baseRev: head,
    note: 'saved through the legacy layout endpoint',
    userId: args.userId,
    archiveDraft: false,
    afterCreate: async publishedRev => {
      if (!draft || !rebased) return;
      // The draft moves above the new head (its baseRev), so it stays
      // publishable and its next autosave does not 409.
      const { count } = await (
        await storeWriter(storeId)
      ).storePageRevision.updateMany({
        where: { id: draft.id, storeId, rev: draft.rev, status: 'draft' },
        data: {
          rev: publishedRev + 1,
          baseRev: publishedRev,
          document: rebased as unknown as object,
          docBytes: docBytes(rebased),
        },
      });
      if (count !== 1) throw new RevConflict();
    },
  });
}

export async function listRevisions(args: {
  storeId: string;
  pageKey: string;
  cursor?: number;
  limit: number;
}) {
  const limit = Math.min(Math.max(args.limit, 1), 50);
  const rows = await (
    await storeWriter(args.storeId)
  ).storePageRevision.findMany({
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
  const names = await publisherNames(args.storeId, [
    ...new Set(page.map(r => r.publishedBy).filter((x): x is string => !!x)),
  ]);
  return {
    revisions: page.map(r => ({
      ...r,
      // null with publishedBy set = the user is gone or erased ("Removed user")
      publishedByName: r.publishedBy ? (names.get(r.publishedBy) ?? null) : null,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].rev : null,
  };
}

export { BUILDER_LIMITS };

// ── Draft preview tokens (Phase 2 editor canvas) ────────────────────────────

/** Redis TTL for a builder preview token (the Redis TTL floor is 120s). */
export const PREVIEW_TOKEN_TTL_SECONDS = 3600;
export { previewTokenKey } from '../lib/builder-preview-token';

/**
 * The document the editor canvas renders for a preview token: the working
 * draft, else published, else the layout-derived document — read fresh on
 * every request, so one token follows the draft as it autosaves.
 */
export async function getPreviewDefinition(
  storeId: string,
  pageKey: string
): Promise<{ definition: PageDefinition; rev: number } | null> {
  const state = await readInStoreContext(storeId, () => getPageState(storeId, pageKey));
  return state ? { definition: state.definition, rev: state.rev } : null;
}
