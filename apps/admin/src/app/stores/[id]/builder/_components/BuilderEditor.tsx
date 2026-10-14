'use client';

/**
 * The visual builder (Phase 2): a Shopify-theme-editor-style three-pane
 * editor, Arabic-first and RTL-mirrored with logical CSS.
 *
 *   top bar  open-door mark · store · viewport switch (desktop/tablet/mobile)
 *            · undo/redo · save status · template families · Publish
 *   start    structure tree (header group / template / footer group), theme
 *            settings, revision history
 *   center   the real storefront in an iframe rendering the unsaved draft
 *   end      settings generated from the selected section's schema
 *
 * Below `lg` the side panes become toggleable drawers over the canvas.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { useToast } from '@force/ui';
import {
  BRAND,
  TEMPLATE_FAMILIES,
  applyTemplateFamily,
  effectiveTheme,
  getLook,
  type ChildToParent,
  type DraftTheme,
  type DocumentAction,
  type SectionList,
  type StoreTheme,
  type Viewport,
} from '@force/shared';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '../../../../../lib/api';
import { getStoreHref } from '../../../../../lib/store-url';
import { useBuilderDocument } from '../_lib/useBuilderDocument';
import { Canvas } from './Canvas';
import { SectionTree, type Selection } from './SectionTree';
import { SettingsPanel } from './SettingsPanel';
import { AddSectionDialog } from './AddSectionDialog';
import { ThemeSettingsPanel } from './ThemeSettingsPanel';
import { RevisionsPanel } from './RevisionsPanel';

interface StoreInfo {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  domain?: string | null;
  theme?: StoreTheme;
  look?: string | null;
}

type StartTab = 'sections' | 'theme' | 'history';

export function BuilderEditor({ storeId }: { storeId: string }) {
  const t = useT('builder');
  const locale = useLocale();
  const { success: toastSuccess, error: toastError } = useToast();
  const b = useBuilderDocument(storeId);
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>('mobile');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [addTo, setAddTo] = useState<SectionList | null>(null);
  const [tab, setTab] = useState<StartTab>('sections');
  const [drawer, setDrawer] = useState<'start' | 'end' | null>(null);
  const [reloadKey, setReloadKey] = useState(1);

  // The LIVE store (its theme is what the storefront shows). Re-read after a
  // publish or a restore, which are the only things that change it here.
  const refreshStore = useCallback(
    () =>
      apiGet<{ store: StoreInfo }>(`/api/v1/admin/stores/${storeId}`).then(r => {
        if (r.data?.store) setStore(r.data.store);
      }),
    [storeId]
  );

  useEffect(() => {
    void refreshStore();
    void apiPost<{ token: string }>(
      `/api/v1/admin/stores/${storeId}/builder/pages/home/preview-token`,
      {}
    ).then(r => {
      if (r.data?.token) setToken(r.data.token);
    });
  }, [storeId, refreshStore]);

  // Saved data changed (a new carousel, a new product source): reload the canvas.
  useEffect(() => {
    if (b.dataEpoch > 0) setReloadKey(k => k + 1);
  }, [b.dataEpoch]);

  const reasons: Record<string, string> = {
    CARDINALITY: t('rejected.cardinality'),
    GROUP_MISMATCH: t('rejected.group'),
    BLOCK_NOT_SUPPORTED: t('rejected.block'),
    NOT_FOUND: t('rejected.notFound'),
    UNKNOWN_TYPE: t('rejected.unknown'),
  };
  const dispatch = useCallback(
    (action: DocumentAction, coalesceKey?: string) => {
      const r = b.dispatch(action, coalesceKey);
      if (r?.rejected) toastError(reasons[r.rejected] ?? r.rejected);
      if (r?.createdId && (action.type === 'addSection' || action.type === 'duplicateSection'))
        setSelection({ sectionId: r.createdId });
      if (r?.createdId && (action.type === 'addBlock' || action.type === 'duplicateBlock'))
        setSelection({ sectionId: action.sectionId, blockId: r.createdId });
      if (action.type === 'removeSection' && selection?.sectionId === action.id) setSelection(null);
      return r;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reasons is derived from t
    [b.dispatch, selection, toastError]
  );

  const onCanvasMessage = useCallback(
    (msg: ChildToParent) => {
      if (msg.type === 'select') {
        setSelection({ sectionId: msg.sectionId, blockId: msg.blockId });
        setDrawer(d => (d === 'start' ? null : d));
      }
      if (msg.type === 'hover') setHovered(msg.sectionId);
      if (msg.type === 'patch-text') {
        const coalesce = `${msg.sectionId}/${msg.blockId ?? ''}/${msg.key}`;
        if (msg.blockId)
          dispatch(
            {
              type: 'setBlockSetting',
              sectionId: msg.sectionId,
              blockId: msg.blockId,
              key: msg.key,
              value: msg.value,
            },
            coalesce
          );
        else
          dispatch(
            { type: 'setSectionSetting', id: msg.sectionId, key: msg.key, value: msg.value },
            coalesce
          );
      }
    },
    [dispatch]
  );

  // Undo / redo shortcuts (leave native text undo alone inside inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        b.undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        b.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [b]);

  // Never lose an unsaved edit by closing the tab.
  useEffect(() => {
    if (!b.dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [b.dirty]);

  // Issues that stop a publish but not a draft save (placeholder text, an
  // imageless hero slide). The API already localizes each message; the banner
  // lists them all so the merchant sees every section to fix, not only the
  // selected one.
  const publishBlockers = b.errors.filter(
    e => e.code === 'PLACEHOLDER_COPY' || e.code === 'MISSING_IMAGE'
  );

  const publish = async () => {
    const r = await b.publish();
    if (r === 'ok') {
      toastSuccess(t('published'));
      void refreshStore();
      // The header/footer patch is live now; re-open the page so the next edit
      // starts from the live values instead of re-sending a stale patch.
      if (b.doc?.chrome) void b.reload();
    } else if (r === 'failed') toastError(t('publishFailed'));
  };

  const applyFamily = (id: (typeof TEMPLATE_FAMILIES)[number]['id']) => {
    if (!b.doc) return;
    if (!window.confirm(t('families.confirm'))) return;
    b.replaceDocument(applyTemplateFamily(b.doc, id));
    toastSuccess(t('families.applied'));
  };

  if (b.loadError)
    return (
      <div className="grid h-screen place-items-center bg-background p-6 text-center">
        <div>
          <p className="text-sm text-destructive-ink">{t('loadError')}</p>
          <button
            type="button"
            onClick={() => void b.reload()}
            className="mt-3 rounded-lg border border-border px-3 py-1.5 text-sm"
          >
            {t('retry')}
          </button>
        </div>
      </div>
    );
  if (!b.doc || !store || !token)
    return (
      <div
        role="status"
        className="grid h-screen place-items-center bg-background text-sm text-muted-foreground"
      >
        {t('loading')}
      </div>
    );

  const storeName = locale === 'ar' && store.nameAr ? store.nameAr : store.name;
  const statusText: Record<string, string> = {
    loading: t('status.loading'),
    saved: t('status.saved'),
    dirty: t('status.dirty'),
    saving: t('status.saving'),
    error: t('status.error'),
    conflict: t('status.conflict'),
  };

  const startPane = (
    <div className="flex h-full flex-col">
      <div
        role="tablist"
        aria-label={t('panes.start')}
        className="flex border-b border-border text-xs"
      >
        {(['sections', 'theme', 'history'] as const).map(k => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`flex-1 px-2 py-2.5 ${tab === k ? 'border-b-2 border-primary font-semibold text-foreground' : 'text-muted-foreground'}`}
          >
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'sections' && (
          <SectionTree
            doc={b.doc}
            selection={selection}
            hoveredId={hovered}
            onSelect={s => {
              setSelection(s);
              setDrawer(d => (d === 'start' ? 'end' : d));
            }}
            dispatch={dispatch}
            onAddSection={setAddTo}
          />
        )}
        {tab === 'theme' && (
          <ThemeSettingsPanel
            storeId={storeId}
            look={getLook(store.look) ?? null}
            liveTheme={(store.theme ?? null) as Record<string, unknown> | null}
            flushDraft={b.saveDraftNow}
            removeDraftKey={key => {
              b.patchDocument(d => {
                const rest = { ...(d.theme ?? {}) } as DraftTheme;
                delete rest[key];
                const next = { ...d } as typeof d & { theme?: unknown };
                if (Object.keys(rest).length > 0) next.theme = rest;
                else delete next.theme;
                return next as typeof d;
              });
              return b.saveDraftNow();
            }}
            onThemeReset={() => {
              // Both the draft and the LIVE theme may have changed: re-read each, repaint the canvas.
              void Promise.all([refreshStore(), b.reload()]).then(() => setReloadKey(k => k + 1));
            }}
            theme={effectiveTheme(store.theme, b.doc.theme)}
            onSave={patch => {
              // Draft only: the edit rides the document (autosave API), the
              // canvas reloads from the draft once it is saved, and the live
              // theme changes only when Publish promotes it.
              b.replaceDocument({ ...b.doc!, theme: { ...b.doc!.theme, ...patch } as DraftTheme });
              return b.saveDraftNow();
            }}
          />
        )}
        {tab === 'history' && (
          <RevisionsPanel
            storeId={storeId}
            headRev={b.rev}
            onRestored={() => {
              toastSuccess(t('restored'));
              void b.reload();
              void refreshStore();
              setReloadKey(k => k + 1);
            }}
          />
        )}
      </div>
    </div>
  );

  const endPane = (
    <SettingsPanel
      storeId={storeId}
      doc={b.doc}
      selection={selection}
      viewport={viewport}
      theme={effectiveTheme(store.theme, b.doc.theme)}
      errors={b.errors}
      dispatch={dispatch}
      chromeEdit={{
        chrome: b.doc.chrome,
        liveVersion: b.publishedRev,
        // Header / footer links ride the draft document (autosave) and go
        // live only on Publish. Each edit carries one key; merge it into the
        // LATEST document so quick edits to different lists never drop each other.
        onChange: patch =>
          b.patchDocument(doc => ({
            ...doc,
            chrome: {
              ...doc.chrome,
              ...patch,
              ...(patch.footerLinks
                ? { footerLinks: { ...doc.chrome?.footerLinks, ...patch.footerLinks } }
                : {}),
              ...(patch.utilityBar
                ? { utilityBar: { ...doc.chrome?.utilityBar, ...patch.utilityBar } }
                : {}),
            },
          })),
      }}
    />
  );

  return (
    <div className="flex h-screen flex-col bg-background text-foreground" data-testid="builder">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1 md:h-14 md:flex-nowrap md:py-0">
        <Link
          href={`/stores/${storeId}`}
          className="flex items-center gap-2"
          aria-label={t('back')}
        >
          {}
          <img src="/logo.svg" alt={BRAND.product.nameEn} width={28} height={28} />
        </Link>
        <span className="hidden truncate text-sm font-semibold sm:inline">{storeName}</span>
        <div className="ms-2 flex lg:hidden">
          <button
            type="button"
            onClick={() => setDrawer(d => (d === 'start' ? null : 'start'))}
            className="rounded px-2 py-1 text-xs hover:bg-muted"
            aria-expanded={drawer === 'start'}
          >
            {t('panes.start')}
          </button>
          <button
            type="button"
            onClick={() => setDrawer(d => (d === 'end' ? null : 'end'))}
            className="rounded px-2 py-1 text-xs hover:bg-muted"
            aria-expanded={drawer === 'end'}
          >
            {t('panes.end')}
          </button>
        </div>
        <div
          role="radiogroup"
          aria-label={t('viewport.label')}
          className="order-last mx-auto inline-flex rounded-lg bg-muted p-0.5 text-xs max-md:max-w-full md:order-none"
        >
          {(['desktop', 'tablet', 'mobile'] as const).map(v => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={viewport === v}
              onClick={() => setViewport(v)}
              className={`rounded-md px-2.5 py-1 ${viewport === v ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground'}`}
              data-testid={`viewport-${v}`}
            >
              {t(`viewport.${v}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={b.undo}
          disabled={!b.canUndo}
          aria-label={t('undo')}
          title={t('undo')}
          className="rounded px-2 py-1 text-sm hover:bg-muted disabled:opacity-30 max-md:ms-auto"
          data-testid="undo"
        >
          ↶
        </button>
        <button
          type="button"
          onClick={b.redo}
          disabled={!b.canRedo}
          aria-label={t('redo')}
          title={t('redo')}
          className="rounded px-2 py-1 text-sm hover:bg-muted disabled:opacity-30"
          data-testid="redo"
        >
          ↷
        </button>
        <span
          role="status"
          className="hidden w-24 text-xs text-muted-foreground md:inline"
          data-testid="save-status"
          data-state={b.saveState}
        >
          {statusText[b.saveState]}
        </span>
        <select
          aria-label={t('families.label')}
          value=""
          onChange={e =>
            e.target.value &&
            applyFamily(e.target.value as (typeof TEMPLATE_FAMILIES)[number]['id'])
          }
          className="hidden rounded-lg border border-border bg-background px-2 py-1 text-xs md:block"
        >
          <option value="">{t('families.label')}</option>
          {TEMPLATE_FAMILIES.map(f => (
            <option key={f.id} value={f.id}>
              {locale === 'ar'
                ? `${f.labelAr} — ${f.verticalAr}`
                : `${f.labelEn} — ${f.verticalEn}`}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void publish()}
          disabled={b.publishing || b.saveState === 'conflict'}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="publish"
        >
          {b.publishing ? t('publishing') : t('publish')}
        </button>
      </header>

      {publishBlockers.length > 0 && (
        <div
          role="alert"
          className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm"
          data-testid="publish-blockers"
        >
          <p className="font-semibold">{t('publishBlocked.title')}</p>
          <ul className="mt-1 list-disc ps-5 text-xs">
            {publishBlockers.map(e => (
              <li key={e.path}>{locale === 'ar' ? e.messageAr : e.messageEn}</li>
            ))}
          </ul>
        </div>
      )}

      {b.saveState === 'conflict' && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm"
          data-testid="conflict-banner"
        >
          <span className="flex-1">{t('conflict.message')}</span>
          <button
            type="button"
            onClick={b.takeTheirs}
            className="rounded-lg border border-border bg-background px-3 py-1 text-xs font-medium"
          >
            {t('conflict.takeTheirs')}
          </button>
          <button
            type="button"
            onClick={() => void b.keepMine()}
            className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground"
          >
            {t('conflict.keepMine')}
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <aside
          aria-label={t('panes.start')}
          className={`${drawer === 'start' ? 'absolute inset-y-0 start-0 z-20 flex w-80 max-w-[85vw] shadow-2xl' : 'hidden'} flex-col border-e border-border bg-card lg:static lg:flex lg:w-72 lg:shadow-none`}
        >
          {startPane}
        </aside>
        <main className="min-w-0 flex-1">
          <Canvas
            storefrontUrl={getStoreHref(store)}
            token={token}
            doc={b.doc}
            viewport={viewport}
            selectedId={selection?.sectionId ?? null}
            reloadKey={reloadKey}
            onMessage={onCanvasMessage}
          />
        </main>
        <aside
          aria-label={t('panes.end')}
          className={`${drawer === 'end' ? 'absolute inset-y-0 end-0 z-20 flex w-80 max-w-[85vw] shadow-2xl' : 'hidden'} flex-col border-s border-border bg-card lg:static lg:flex lg:w-80 lg:shadow-none`}
        >
          {endPane}
        </aside>
      </div>

      {addTo && (
        <AddSectionDialog
          list={addTo}
          doc={b.doc}
          onClose={() => setAddTo(null)}
          onPick={(sectionType, presetIndex) => {
            dispatch({ type: 'addSection', list: addTo, sectionType, presetIndex });
            setAddTo(null);
          }}
        />
      )}
    </div>
  );
}
