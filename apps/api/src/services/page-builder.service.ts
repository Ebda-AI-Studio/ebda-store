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
} from '@ebda/shared';
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
      },
    })
  );
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

function resolvedLayout(store: {
  layoutSettings: unknown;
  template: string | null;
  look?: string | null;
}) {
  return resolveLayoutSettings(
    store.layoutSettings ?? {},
    (store.template ?? undefined) as TemplateId | undefined,
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
  // Same for the header/footer content patch (`chrome`): once published it is
  // live in `stores.settings`, so it is not re-opened as a pending edit.
  delete rest.chrome;
  return rest;
}

export async function getPageState(storeId: string, pageKey: string): Promise<PageState | null> {
  const store = await loadStore(storeId);
  if (!store) return null;
  const { draft, published, head } = await loadRows(storeId, pageKey);
  return {
    rev: head,
    definition: draft
      ? (draft.document as PageDefinition)
      : published
        ? withoutTheme(published.document)
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
  const published = await readInStoreContext(storeId, () =>
    prisma.storePageRevision.findFirst({
      where: { storeId, pageKey, status: 'published' },
      select: { rev: true, document: true },
    })
  );
  if (published) {
    const doc = published.document as unknown as PageDefinition;
    try {
      if (publishedDocumentAgrees(doc, layout, templateId ?? undefined, look))
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

/**
 * Extra columns for the row publish promotes: when the draft carries a theme
 * patch, the published document records a full snapshot of the editor-managed
 * keys (live ⊕ patch) so rolling back to it restores exactly those keys.
 */
function publishedThemeData(document: unknown, liveTheme: unknown): Record<string, unknown> {
  const doc = document as PageDefinition;
  if (!doc.theme) return {};
  const snapshotted = {
    ...doc,
    theme: snapshotEditableTheme(liveTheme as Record<string, unknown> | null, doc.theme),
  };
  return { document: snapshotted as unknown as object, docBytes: docBytes(snapshotted) };
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
  const themePatch = definition.theme;
  const chromePatch = hasChromePatch(definition.chrome) ? definition.chrome : undefined;
  await withStore(storeId, async tx => {
    // Merge the pending theme / header+footer content over the CURRENT live
    // values read in this same transaction (the Branding tab and the classic
    // builder also write other theme / settings keys), and write them with
    // layout_settings in one statement.
    const live =
      themePatch || chromePatch
        ? await tx.store.findUnique({
            where: { id: storeId },
            select: { theme: true, settings: true },
          })
        : null;
    return tx.store.update({
      where: { id: storeId },
      data: {
        layoutSettings: layout as unknown as object,
        ...(themePatch ? { theme: { ...((live?.theme ?? {}) as object), ...themePatch } } : {}),
        ...(chromePatch
          ? { settings: applyChromePatch(live?.settings, chromePatch) as unknown as object }
          : {}),
      },
    });
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

  const outcome = await promote(storeId, pageKey, async () => {
    const { count } = await prisma.storePageRevision.updateMany({
      where: { id: draft.id, storeId, rev: baseRev, status: 'draft' },
      data: {
        status: 'published',
        publishedAt: new Date(),
        ...publishedThemeData(draft.document, store.theme),
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
 * document). Runs in the CALLER's tenant scope, like the builder routes: it only
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
export async function applyFamilyForLook(
  storeId: string,
  family: TemplateFamily['id'],
  userId: string | null = null,
  resetThemeKeys: readonly string[] = [],
  /** The look being applied. The store row still holds the OLD look/template here (the builder
   *  step runs first), so a layout-derived page is re-derived for the new skin + look: the look
   *  owns the default card image ratio, and the old skin's card shape must not be baked into
   *  the new document (Ruling LOOKS-15). */
  lookId: string | null = null
): Promise<'published' | 'draft'> {
  const state = await getPageState(storeId, HOME_PAGE_KEY);
  if (!state) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  const store = await loadStore(storeId);
  if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  const look = getLook(lookId);
  const start =
    state.source === 'layout' && look
      ? layoutToDefinition(
          resolveLayoutSettings(store.layoutSettings ?? {}, look.skin, look.id),
          HOME_PAGE_KEY
        )
      : state.definition;
  let definition = applyTemplateFamily(start, family);
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
      const { count } = await prisma.storePageRevision.updateMany({
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
