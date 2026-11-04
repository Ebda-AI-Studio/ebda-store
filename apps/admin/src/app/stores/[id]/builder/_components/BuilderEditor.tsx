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
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { useToast } from '@ebda/ui';
import {
  BRAND,
  effectiveTheme,
  getLook,
  type LookId,
  type PageDefinition,
  addRequestFor,
  applySmartPalette,
  applyTypographyPatch,
  aiFillActions,
  aiFillRequestFor,
  aiFillRequestForSection,
  type AiFillRequest,
  type AiSuggestion,
  getSectionDefinition,
  imageSwapActions,
  intentToAction,
  locateSection,
  type IntentResult,
  mediaRequestFor,
  recommendedSizeTextForTemplateI18n,
  type MediaRequest,
  type TemplateId,
  normalizeLegacyTemplate,
  type ChildToParent,
  type DraftTheme,
  type DocumentAction,
  type SectionList,
  type StoreTheme,
  type ZoneOverride,
  type Viewport,
  type PageKind,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost, apiPut } from '../../../../../lib/api';
import { getStoreHref } from '../../../../../lib/store-url';
import { useBuilderDocument } from '../_lib/useBuilderDocument';
import { setCanvasHover } from '../_lib/canvas-hover-store';
import { describeMove, describeStructure } from '../_lib/announce-move';
import { rovingKeyDown } from '../_lib/roving';
import { useDrawerA11y } from '../_lib/use-drawer-a11y';
import { resolveDeepLink, type DeepLinkParams } from '../_lib/deeplink';
import { locateAndHighlight } from '../../../../../lib/setting-highlight';
import { ConfirmDialog } from './ConfirmDialog';
import type { FontEntry } from '../../../../../components/section-design/FontsCard';
import { ImageSwapDialog } from './ImageSwapDialog';
import { Canvas } from './Canvas';
import { SectionTree, type Selection } from './SectionTree';
import { SettingsPanel } from './SettingsPanel';
import { AddSectionDialog } from './AddSectionDialog';
import { ThemeSettingsPanel } from './ThemeSettingsPanel';
import { RevisionsPanel } from './RevisionsPanel';
import { AiPatchPane, type AiPatchProposal } from './AiPatchPane';
import { PageSwitcher, type PreviewProduct } from './PageSwitcher';
import { PageSettingsPanel } from './PageSettingsPanel';
import { LookSwitchPane, type LookDesignChoice, type LookPreviewResult } from './LookSwitchPane';

interface StoreInfo {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  domain?: string | null;
  theme?: StoreTheme;
  look?: string | null;
  template?: string | null;
}

type StartTab = 'sections' | 'theme' | 'ai' | 'history';

/** Smart Palette over a document (the modal's `ThemeUpdates` is a plain record of theme keys). */
const applyPalette = (
  doc: Parameters<typeof applySmartPalette>[0],
  palette: Parameters<typeof applySmartPalette>[1],
  updates: object
) => applySmartPalette(doc, palette, { ...updates });

const VIEWPORT_KEY = 'ebda.builder.viewport';

/** The device the editor opens on: the remembered one, else the one that fits the window. */
export function initialViewport(stored: string | null, windowWidth: number): Viewport {
  if (stored === 'desktop' || stored === 'tablet' || stored === 'mobile') return stored;
  return windowWidth >= 1024 ? 'desktop' : windowWidth >= 768 ? 'tablet' : 'mobile';
}

export function BuilderEditor({
  storeId,
  pageKey = 'home',
  onPageChange,
  deepLink,
}: {
  storeId: string;
  /** The page being edited (Ruling VE-3 amended); the parent remounts this component per page. */
  pageKey?: PageKind;
  onPageChange?: (next: PageKind) => void;
  /** `?select=&block=&field=` from the URL, already shape-checked (Task 11). */
  deepLink?: DeepLinkParams;
}) {
  const t = useT('builder');
  const locale = useLocale();
  const { success: toastSuccess, error: toastError } = useToast();
  const b = useBuilderDocument(storeId, pageKey);
  const isHome = pageKey === 'home';
  const [store, setStore] = useState<StoreInfo | null>(null);
  // The LIVE typography (fonts + zones); the draft's patch is applied over it for the theme pane.
  const [liveTypography, setLiveTypography] = useState<unknown>(null);
  const [token, setToken] = useState<string | null>(null);
  // E-4: open on the device that matches the window (a desktop merchant starts on Desktop), or the
  // last device they chose. The choice is a per-browser convenience, so storage may be unavailable.
  const [viewport, setViewportState] = useState<Viewport>('mobile');
  const setViewport = useCallback((v: Viewport) => {
    setViewportState(v);
    try {
      window.localStorage.setItem(VIEWPORT_KEY, v);
    } catch {
      /* private window: the choice just is not remembered */
    }
  }, []);
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(VIEWPORT_KEY);
    } catch {
      /* storage blocked */
    }
    setViewportState(initialViewport(stored, window.innerWidth));
  }, []);
  const [selection, setSelection] = useState<Selection | null>(null);
  // Keyboard path (Task 13): a request for the canvas to take focus, and the live-region text.
  const [focusRequest, setFocusRequest] = useState<{
    sectionId: string;
    blockId?: string;
    n: number;
  } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [addTo, setAddTo] = useState<SectionList | null>(null);
  // Where "+" on the canvas asked to insert (undefined: the end, from the tree's own button).
  const [addAt, setAddAt] = useState<number | undefined>(undefined);
  // A destructive canvas action waiting for the in-app confirmation.
  const [pending, setPending] = useState<{ intent: IntentResult; name: string } | null>(null);
  // "Change image" asked for on the canvas (the file is picked HERE, never by the canvas).
  const [mediaReq, setMediaReq] = useState<MediaRequest | null>(null);
  // A fresh number per swap, so each swap is its own undo step.
  const swapSeq = useRef(0);
  // One AI fill at a time; a fresh number per fill makes each one a single undo step.
  const aiBusy = useRef(false);
  const aiSeq = useRef(0);
  const [tab, setTab] = useState<StartTab>('sections');
  const [drawer, setDrawer] = useState<'start' | 'end' | null>(null);
  const [reloadKey, setReloadKey] = useState(1);
  // Changing the look (Task 9): the pane is open, a proposal is being shown in the canvas, a call is in flight.
  const [lookOpen, setLookOpen] = useState(false);
  const [lookPreview, setLookPreview] = useState<
    (LookPreviewResult & { draft: PageDefinition; design: LookDesignChoice }) | null
  >(null);
  const [lookBusy, setLookBusy] = useState<'preview' | 'apply' | null>(null);
  // Ask AI (Phase 5): a validated patch proposal shown in the canvas over the saved draft; nothing is
  // written until Apply, and Apply writes the DRAFT only.
  const [patchPreview, setPatchPreview] = useState<
    (AiPatchProposal & { candidate: PageDefinition }) | null
  >(null);
  const [patchBusy, setPatchBusy] = useState<'ask' | 'apply' | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);

  // The LIVE store (its theme is what the storefront shows). Re-read after a
  // publish or a restore, which are the only things that change it here.
  const refreshStore = useCallback(
    () =>
      apiGet<{ store: StoreInfo }>(`/api/v1/admin/stores/${storeId}`).then(r => {
        if (r.data?.store) setStore(r.data.store);
      }),
    [storeId]
  );

  const refreshTypography = useCallback(
    () =>
      apiGet<{ typography?: unknown }>(`/api/v1/stores/${storeId}/typography`).then(r => {
        if (r.data?.typography) setLiveTypography(r.data.typography);
      }),
    [storeId]
  );

  useEffect(() => {
    void refreshTypography();
    void refreshStore();
    void apiPost<{ token: string }>(
      `/api/v1/admin/stores/${storeId}/builder/pages/${pageKey}/preview-token`,
      {}
    ).then(r => {
      if (r.data?.token) setToken(r.data.token);
    });
  }, [storeId, pageKey, refreshStore]);

  // The product page is previewed with one of the store's own products.
  const [previewProducts, setPreviewProducts] = useState<PreviewProduct[]>([]);
  const [previewSlug, setPreviewSlug] = useState<string | null>(null);
  useEffect(() => {
    if (pageKey !== 'product') return;
    void apiGet<{ products?: PreviewProduct[] }>(
      `/api/v1/stores/${storeId}/products?status=active&limit=20`
    ).then(r => {
      const list = (r.data?.products ?? []).filter(p => p.slug);
      setPreviewProducts(list);
      setPreviewSlug(prev => prev ?? list[0]?.slug ?? null);
    });
  }, [storeId, pageKey]);
  const canvasPath =
    pageKey === 'cart'
      ? '/cart'
      : pageKey === 'collection'
        ? '/products'
        : pageKey === 'product' && previewSlug
          ? `/products/${encodeURIComponent(previewSlug)}`
          : '/';

  // Switch page: flush this page's pending draft first, so nothing is lost when the editor remounts.
  const switchPage = useCallback(
    async (next: PageKind) => {
      if (next === pageKey) return;
      if (b.dirty && !(await b.saveDraftNow())) {
        toastError(t('pages.saveFirst'));
        return;
      }
      onPageChange?.(next);
    },
    [b, pageKey, onPageChange, toastError, t]
  );

  // The deep link (⌘K, a pasted URL) is applied ONCE, when the document first arrives: it selects
  // the section (canvas + tree follow `selection`), opens the tab or pane that holds the control and
  // rings the field. An unknown id selects nothing and breaks nothing.
  const linkApplied = useRef<string | null>(null);
  const [focusField, setFocusField] = useState<string | undefined>(undefined);
  useEffect(() => {
    // Once per distinct link: a doc edit never re-applies it, a NEW link on the open page does.
    const key = JSON.stringify([deepLink?.select, deepLink?.block, deepLink?.field]);
    if (linkApplied.current === key || !b.doc) return;
    linkApplied.current = key;
    if (!deepLink || (!deepLink.select && !deepLink.field)) return;
    const target = resolveDeepLink(b.doc, deepLink, { canOpenTheme: isHome });
    if (target.tab) {
      setTab(target.tab);
      setDrawer('start');
    }
    if (target.selection) {
      setSelection(target.selection);
      setDrawer('end');
    }
    setFocusField(target.field);
  }, [b.doc, deepLink, isHome]);
  useEffect(() => {
    if (!focusField) return;
    return locateAndHighlight(focusField);
  }, [focusField]);

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
    PINNED: t('rejected.pinned'),
    PAGE_MISMATCH: t('rejected.page'),
    UNKNOWN_SETTING: t('rejected.setting'),
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

  // The latest document, read by the canvas message handler without re-subscribing it.
  const docRef = useRef(b.doc);
  docRef.current = b.doc;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // The latest dispatch, for async work (the AI fill) that outlives a render.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  /** Ask the API for a kicker and subtitle, then dispatch the empty ones as ordinary, undoable edits. */
  const runAiFill = useCallback(
    async (req: AiFillRequest) => {
      if (aiBusy.current) return;
      aiBusy.current = true;
      try {
        const { data, error } = await apiPost<{ suggestion: AiSuggestion }>(
          `/api/v1/stores/${storeId}/ai/section-content`,
          {
            section: req.section,
            existingTitle: req.existingTitle,
            existingTitleAr: req.existingTitleAr,
          }
        );
        const cur = docRef.current;
        if (error || !data || !cur) return toastError(t('ai.failed'));
        const fills = aiFillActions(cur, req.sectionId, data.suggestion, aiSeq.current++);
        if (fills.length === 0) return toastSuccess(t('ai.nothing'));
        for (const f of fills) dispatchRef.current(f.action, f.coalesce);
        toastSuccess(t('ai.filled'));
      } catch {
        toastError(t('ai.failed'));
      } finally {
        aiBusy.current = false;
      }
    },
    [storeId, t, toastError, toastSuccess]
  );

  // Picking a section closes the look pane: the right pane follows what is selected.
  useEffect(() => {
    if (selection) setLookOpen(false);
  }, [selection]);
  const previewingRef = useRef(false);
  previewingRef.current = lookPreview !== null || patchPreview !== null;
  // A proposal is computed from the document as it was; if the draft moves under it (the tree,
  // a tab, autosave) the proposal is stale and Apply would only answer DRAFT_MOVED, so drop it.
  const previewBaseDoc = useRef<typeof b.doc>(null);
  useEffect(() => {
    if (!lookPreview) {
      previewBaseDoc.current = null;
      return;
    }
    if (previewBaseDoc.current === null) previewBaseDoc.current = b.doc;
    else if (previewBaseDoc.current !== b.doc) setLookPreview(null);
  }, [lookPreview, b.doc]);
  const patchBaseDoc = useRef<typeof b.doc>(null);
  useEffect(() => {
    if (!patchPreview) {
      patchBaseDoc.current = null;
      return;
    }
    if (patchBaseDoc.current === null) patchBaseDoc.current = b.doc;
    else if (patchBaseDoc.current !== b.doc) setPatchPreview(null);
  }, [patchPreview, b.doc]);
  const onCanvasMessage = useCallback(
    (msg: ChildToParent) => {
      // While a proposed look is shown the canvas is read-only: nothing it sends edits the real page.
      if (previewingRef.current) return;
      if (msg.type === 'select') {
        setSelection({ sectionId: msg.sectionId, blockId: msg.blockId });
        setDrawer(d => (d === 'start' ? null : d));
      }
      if (msg.type === 'hover') setCanvasHover(msg.sectionId);
      if (msg.type === 'open-admin') {
        // A hint on the canvas ("add products"): the page opens beside the editor, the draft is untouched.
        window.open(`/stores/${storeId}/${msg.target}`, '_blank', 'noopener');
        return;
      }
      if (msg.type === 'focus-tree') {
        // Esc in the canvas: back to the tree row of what is selected (the tree is the outline).
        setTab('sections');
        setDrawer('start');
        const sel = selectionRef.current;
        // Below lg the tree lives in a drawer that mounts and takes its own focus a frame or two
        // later, so one rAF can lose the race (the tree row was still hidden): retry until the row
        // actually holds focus (a11y: the Esc-from-canvas return must land on the tree row).
        const focusRow = () => {
          const row =
            (sel &&
              document.querySelector<HTMLElement>(
                `[data-testid="tree-select-${window.CSS.escape(sel.sectionId)}"]`
              )) ||
            document.querySelector<HTMLElement>('[data-testid^="tree-select-"]');
          // The drawer takes its own focus (close button) after it mounts, so this must run after
          // it; the retries stop within 400 ms of the Esc.
          if (row && document.activeElement !== row) row.focus();
        };
        requestAnimationFrame(focusRow);
        for (const ms of [60, 180, 400]) setTimeout(focusRow, ms);
        return;
      }
      // Every other intent is re-validated against the CURRENT document and the registry
      // (VE-2) and becomes exactly one document action, or is dropped.
      const doc = docRef.current;
      if (msg.type === 'request-media') {
        const req = doc ? mediaRequestFor(doc, msg) : null;
        if (req) setMediaReq(req);
        return;
      }
      if (msg.type === 'section-op' && msg.op === 'aiFill') {
        const req = doc ? aiFillRequestFor(doc, msg) : null;
        if (req) void runAiFill(req);
        return;
      }
      if (msg.type === 'request-add') {
        const req = doc ? addRequestFor(doc, msg) : null;
        if (req) {
          setAddAt(req.index);
          setAddTo(req.list);
        }
        return;
      }
      const intent = doc ? intentToAction(doc, msg) : null;
      if (!intent) return;
      if (intent.confirm && doc && msg.type === 'section-op') {
        // Remove asks first, in the app (not window.confirm); Undo brings it back.
        const node = locateSection(doc, msg.sectionId)?.node;
        const def = node ? getSectionDefinition(node.type) : undefined;
        const blockType = node?.blocks?.find(x => x.id === msg.blockId)?.type;
        const bd = msg.blockId ? def?.blocks.find(b => b.type === blockType) : undefined;
        const ar = locale === 'ar';
        setPending({
          intent,
          name: (bd ? (ar ? bd.labelAr : bd.labelEn) : ar ? def?.labelAr : def?.labelEn) ?? '',
        });
        return;
      }
      dispatch(intent.action, intent.coalesce);
    },
    [dispatch, locale, runAiFill]
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
      void refreshTypography();
      // The header/footer and typography patches are live now; re-open the page so the next edit
      // starts from the live values instead of re-sending a stale patch.
      if (b.doc?.chrome || b.doc?.typography) void b.reload();
    } else if (r === 'failed') toastError(t('publishFailed'));
  };

  /** Save this page's pending edits so the server previews and applies from the same draft. */
  const settleDraft = async (): Promise<boolean> => {
    if (b.saveState === 'conflict') return false;
    if (b.dirty && !(await b.saveDraftNow())) return false;
    return true;
  };

  const previewLook = async (lookId: string, design: LookDesignChoice) => {
    setLookBusy('preview');
    try {
      if (!(await settleDraft())) return void toastError(t('look.saveFirst'));
      const r = await apiPost<LookPreviewResult & { draft: PageDefinition }>(
        `/api/v1/stores/${storeId}/look/preview`,
        { lookId, design }
      );
      if (r.error || !r.data) return void toastError(t('look.previewFailed'));
      setLookPreview({ ...r.data, design });
      setDrawer(d => (d === 'end' ? null : d));
    } finally {
      setLookBusy(null);
    }
  };

  const askAiPatch = async (instruction: string) => {
    setPatchBusy('ask');
    setPatchError(null);
    try {
      if (!(await settleDraft())) return void setPatchError(t('aiPatch.saveFirst'));
      const r = await apiPost<AiPatchProposal & { candidate: PageDefinition }>(
        `/api/v1/stores/${storeId}/ai/builder-patch`,
        { pageKey, instruction }
      );
      if (r.error || !r.data) {
        const code = r.error?.code ?? '';
        return void setPatchError(
          code.startsWith('AI_QUOTA') || code === 'AI_BUDGET_EXCEEDED'
            ? t('aiPatch.quota')
            : t('aiPatch.failed')
        );
      }
      setPatchPreview(r.data);
      setDrawer(d => (d === 'start' ? null : d));
    } finally {
      setPatchBusy(null);
    }
  };

  const applyAiPatchNow = async () => {
    if (!patchPreview) return;
    setPatchBusy('apply');
    try {
      // One undo step, then the normal draft save: a hand edit and an AI edit are the same thing to the page.
      const candidate = patchPreview.candidate;
      setPatchPreview(null);
      b.replaceDocument(candidate);
      if (await b.saveDraftNow()) toastSuccess(t('aiPatch.applied'));
      else setPatchError(t('aiPatch.failed'));
    } finally {
      setPatchBusy(null);
    }
  };

  const applyLookNow = async () => {
    if (!lookPreview) return;
    setLookBusy('apply');
    try {
      const r = await apiPut(`/api/v1/stores/${storeId}/look`, {
        lookId: lookPreview.look,
        design: lookPreview.design,
        revisionToken: lookPreview.revisionToken,
      });
      if (r.error) {
        // the page moved since the preview: show nothing stale, ask for a new preview
        setLookPreview(null);
        setDrawer('end'); // back to the picker, to preview again
        return void toastError(r.error.code === 'DRAFT_MOVED' ? t('look.moved') : t('look.failed'));
      }
      toastSuccess(t('look.applied'));
      setLookPreview(null);
      setLookOpen(false);
      await b.reload();
      void refreshStore();
      void refreshTypography();
      setReloadKey(k => k + 1);
    } finally {
      setLookBusy(null);
    }
  };

  // Below lg the panes are drawers: trap focus, close on Esc, return focus to the opener.
  const startRef = useRef<HTMLElement>(null);
  const endRef = useRef<HTMLElement>(null);
  useDrawerA11y(startRef, drawer === 'start', () => setDrawer(null));
  useDrawerA11y(endRef, drawer === 'end', () => setDrawer(null));

  // A move is announced in a live region whichever way it happened (drag, buttons, Alt+Arrow, the
  // canvas toolbar). Egyptian Arabic in ar, plain English in en.
  const prevDoc = useRef<PageDefinition | null>(null);
  useEffect(() => {
    const prev = prevDoc.current;
    prevDoc.current = b.doc;
    if (!prev || !b.doc || prev === b.doc) return;
    const nameOf = (type: string) => {
      const def = getSectionDefinition(type);
      return (locale === 'ar' ? def?.labelAr : def?.labelEn) ?? type;
    };
    // The same sentence twice in a row (two removals of the same kind of section) is not re-read
    // when the text is unchanged, so every announcement alternates a trailing no-break space.
    const say = (text: string) =>
      setAnnouncement(a => (a.endsWith('\u00a0') ? text : `${text}\u00a0`));
    const move = describeMove(prev, b.doc, selectionRef.current?.sectionId);
    if (move) {
      say(
        t(move.direction === 'up' ? 'live.movedUp' : 'live.movedDown', {
          name: nameOf(move.node.type),
          pos: move.pos,
          total: move.total,
        })
      );
      return;
    }
    // Add / remove / hide / show, and what Undo and Redo do to them: silent otherwise.
    const change = describeStructure(prev, b.doc);
    if (change)
      say(
        t(`live.${change.kind}`, {
          name: nameOf(change.node.type),
          pos: change.pos,
          total: change.total,
        })
      );
  }, [b.doc, locale, t]);

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

  // Fonts + zones as the theme pane shows them: the live typography with the draft patch on top.
  const effectiveTypo = applyTypographyPatch(liveTypography, b.doc.typography);

  const startPane = (
    <div className="flex h-full flex-col">
      <div
        role="tablist"
        aria-label={t('panes.start')}
        onKeyDown={e => rovingKeyDown(e, 'tab')}
        className="flex border-b border-border text-xs"
      >
        {(isHome
          ? (['sections', 'theme', 'ai', 'history'] as const)
          : (['sections', 'ai', 'history'] as const)
        ).map(k => (
          <button
            key={k}
            role="tab"
            type="button"
            id={`builder-tab-${k}`}
            aria-selected={tab === k}
            aria-controls="builder-tabpanel"
            tabIndex={tab === k ? 0 : -1}
            onClick={() => setTab(k)}
            className={`flex-1 px-2 py-2.5 ${tab === k ? 'border-b-2 border-primary font-semibold text-foreground' : 'text-muted-foreground'}`}
          >
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="builder-tabpanel"
        aria-labelledby={`builder-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {tab === 'sections' && (
          <button
            type="button"
            onClick={() => {
              setSelection(null);
              setDrawer(d => (d === 'start' ? 'end' : d));
            }}
            aria-current={!selection ? 'true' : undefined}
            className={`mx-2 mt-2 block w-[calc(100%-1rem)] rounded-lg border border-border px-2 py-1.5 text-start text-xs font-medium hover:bg-muted ${!selection ? 'bg-primary/15 ring-1 ring-primary' : ''}`}
            data-testid="open-page-settings"
          >
            {t('pageSettings.open')}
          </button>
        )}
        {tab === 'sections' && (
          <SectionTree
            doc={b.doc}
            selection={selection}
            onSelect={s => {
              setSelection(s);
              setDrawer(d => (d === 'start' ? 'end' : d));
            }}
            onFocusCanvas={s => {
              // Enter on a row: the drawer gets out of the way and the canvas takes focus.
              setDrawer(null);
              setFocusRequest(r => ({ ...s, n: (r?.n ?? 0) + 1 }));
            }}
            dispatch={dispatch}
            onAddSection={list => {
              setAddAt(undefined);
              setAddTo(list);
            }}
          />
        )}
        {isHome && tab === 'theme' && (
          <ThemeSettingsPanel
            storeId={storeId}
            look={getLook(store.look) ?? null}
            storeTemplate={store.template ? normalizeLegacyTemplate(store.template) : undefined}
            // A reset is a DRAFT edit: `null` in the draft theme removes the key at Publish.
            onResetKey={key => {
              b.patchDocument(d => ({
                ...d,
                theme: { ...(d.theme ?? {}), [key]: null } as DraftTheme,
              }));
              return b.saveDraftNow();
            }}
            theme={effectiveTheme(store.theme, b.doc.theme)}
            onSave={patch => {
              // Draft only: the edit rides the document (autosave API), the
              // canvas reloads from the draft once it is saved, and the live
              // theme changes only when Publish promotes it.
              b.replaceDocument({ ...b.doc!, theme: { ...b.doc!.theme, ...patch } as DraftTheme });
              return b.saveDraftNow();
            }}
            typography={{
              fonts: effectiveTypo.fonts as FontEntry[],
              zones: effectiveTypo.zones as Record<string, ZoneOverride | undefined>,
            }}
            onTypography={patch =>
              b.patchDocument(
                d => ({
                  ...d,
                  typography: {
                    ...(d.typography ?? {}),
                    ...(patch.fonts ? { fonts: patch.fonts } : {}),
                    ...(patch.zones
                      ? { zones: { ...(d.typography?.zones ?? {}), ...patch.zones } }
                      : {}),
                  },
                }),
                `typography/${patch.fonts ? 'fonts' : Object.keys(patch.zones ?? {}).join(',')}`
              )
            }
            onApplyPalette={(palette, updates) => {
              // Smart Palette is one draft edit: the section colours and the brand tokens together, so
              // a single Undo takes the whole palette back and nothing is live before Publish.
              b.patchDocument(d => applyPalette(d, palette, updates), 'smart-palette');
            }}
          />
        )}
        {tab === 'ai' && (
          <AiPatchPane
            busy={patchBusy}
            proposal={patchPreview}
            error={patchError}
            onAsk={text => void askAiPatch(text)}
            onApply={() => void applyAiPatchNow()}
            onDiscard={() => setPatchPreview(null)}
          />
        )}
        {tab === 'history' && (
          <RevisionsPanel
            storeId={storeId}
            pageKey={pageKey}
            headRev={b.rev}
            onRestored={() => {
              toastSuccess(t('restored'));
              void b.reload();
              void refreshStore();
              void refreshTypography();
              setReloadKey(k => k + 1);
            }}
          />
        )}
      </div>
    </div>
  );

  // Nothing selected: the page's own settings (background, spacing, filters, image shapes...).
  const endPane =
    lookOpen && !selection ? (
      <LookSwitchPane
        currentLook={(store.look as LookId | null | undefined) ?? null}
        preview={lookPreview}
        busy={lookBusy}
        onPreview={(id, design) => void previewLook(id, design)}
        onApply={() => void applyLookNow()}
        onCancelPreview={() => setLookPreview(null)}
      />
    ) : !selection ? (
      <PageSettingsPanel
        storeId={storeId}
        pageKey={pageKey}
        doc={b.doc}
        theme={effectiveTheme(store.theme, b.doc.theme)}
        dispatch={dispatch}
        onSwitchPage={next => void switchPage(next)}
      />
    ) : (
      <SettingsPanel
        storeId={storeId}
        doc={b.doc}
        selection={selection}
        viewport={viewport}
        onViewportChange={setViewport}
        theme={effectiveTheme(store.theme, b.doc.theme)}
        template={store.template ? normalizeLegacyTemplate(store.template) : undefined}
        look={store.look}
        errors={b.errors}
        dispatch={dispatch}
        focusField={focusField}
        onAiFill={sectionId => {
          const req = b.doc ? aiFillRequestForSection(b.doc, sectionId) : null;
          if (req) void runAiFill(req);
        }}
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
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="builder-live"
      >
        {announcement}
      </div>
      <div className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:start-2 focus-within:top-2 focus-within:z-50 focus-within:flex focus-within:gap-2 focus-within:rounded-lg focus-within:bg-background focus-within:p-2 focus-within:shadow-lg">
        <button
          type="button"
          onClick={() => {
            setDrawer('end');
            requestAnimationFrame(() => document.getElementById('builder-settings')?.focus());
          }}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-semibold"
          data-testid="skip-to-settings"
        >
          {t('skip.settings')}
        </button>
      </div>
      <h1 className="sr-only">{`${t('title')}: ${storeName}`}</h1>
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1 lg:h-14 lg:flex-nowrap lg:py-0">
        <Link
          href={`/stores/${storeId}`}
          className="flex items-center justify-center gap-2 max-lg:min-h-11 max-lg:min-w-11"
          aria-label={t('back')}
        >
          {}
          <img src="/logo.svg" alt={BRAND.product.nameEn} width={15} height={28} />
        </Link>
        <span className="hidden truncate text-sm font-semibold sm:inline">{storeName}</span>
        <PageSwitcher
          pageKey={pageKey}
          onChange={next => void switchPage(next)}
          products={previewProducts}
          previewSlug={previewSlug}
          onPreviewSlug={setPreviewSlug}
        />
        <div className="ms-2 flex lg:hidden">
          <button
            type="button"
            onClick={() => setDrawer(d => (d === 'start' ? null : 'start'))}
            className="rounded px-2 py-1 text-xs hover:bg-muted max-lg:min-h-11 max-lg:px-3"
            aria-expanded={drawer === 'start'}
          >
            {t('panes.start')}
          </button>
          <button
            type="button"
            onClick={() => setDrawer(d => (d === 'end' ? null : 'end'))}
            className="rounded px-2 py-1 text-xs hover:bg-muted max-lg:min-h-11 max-lg:px-3"
            aria-expanded={drawer === 'end'}
          >
            {t('panes.end')}
          </button>
        </div>
        <div
          role="radiogroup"
          aria-label={t('viewport.label')}
          onKeyDown={e => rovingKeyDown(e, 'radio')}
          className="order-last mx-auto inline-flex rounded-lg bg-muted p-0.5 text-xs max-lg:max-w-full lg:order-none"
        >
          {(['desktop', 'tablet', 'mobile'] as const).map(v => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={viewport === v}
              tabIndex={viewport === v ? 0 : -1}
              onClick={() => setViewport(v)}
              className={`rounded-md px-2.5 py-1 max-lg:min-h-11 ${viewport === v ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground'}`}
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
          className="rounded px-2 py-1 text-sm hover:bg-muted disabled:opacity-30 max-lg:ms-auto max-lg:min-h-11 max-lg:min-w-11"
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
          className="rounded px-2 py-1 text-sm hover:bg-muted disabled:opacity-30 max-lg:min-h-11 max-lg:min-w-11"
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
        {isHome && (
          <button
            type="button"
            onClick={() => {
              setLookOpen(o => !o);
              setSelection(null);
              setDrawer(d => (d === 'end' ? d : 'end'));
            }}
            aria-pressed={lookOpen}
            className={`rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted max-lg:min-h-11 ${lookOpen ? 'bg-muted' : 'bg-background'}`}
            data-testid="open-look-switch"
            data-setting-id="builder.look-switch"
          >
            {t('look.open')}
          </button>
        )}
        <button
          type="button"
          onClick={() => void publish()}
          disabled={b.publishing || b.saveState === 'conflict'}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 max-lg:min-h-11"
          data-testid="publish"
        >
          {b.publishing ? t('publishing') : t('publish')}
        </button>
      </header>

      {patchPreview && !lookPreview && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm"
          data-testid="ai-patch-bar"
        >
          <span className="flex-1">{t('aiPatch.bar')}</span>
          {patchPreview.changes.length > 0 && (
            <button
              type="button"
              onClick={() => void applyAiPatchNow()}
              disabled={patchBusy !== null}
              className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {patchBusy === 'apply' ? t('aiPatch.applying') : t('aiPatch.apply')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setPatchPreview(null)}
            disabled={patchBusy !== null}
            className="rounded-lg border border-border bg-background px-3 py-1 text-xs font-medium disabled:opacity-50"
          >
            {t('aiPatch.discard')}
          </button>
        </div>
      )}

      {lookPreview && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm"
          data-testid="look-preview-bar"
        >
          <span className="flex-1">
            {t('look.bar', {
              look: getLook(lookPreview.look)?.name[locale === 'ar' ? 'ar' : 'en'] ?? '',
            })}
          </span>
          <button
            type="button"
            onClick={() => void applyLookNow()}
            disabled={lookBusy !== null}
            className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            data-testid="look-bar-apply"
          >
            {lookBusy === 'apply' ? t('look.applying') : t('look.apply')}
          </button>
          <button
            type="button"
            onClick={() => setLookPreview(null)}
            disabled={lookBusy !== null}
            className="rounded-lg border border-border bg-background px-3 py-1 text-xs font-medium disabled:opacity-50"
            data-testid="look-bar-keep"
          >
            {t('look.keepEditing')}
          </button>
        </div>
      )}

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
          ref={startRef}
          aria-label={t('panes.start')}
          className={`${drawer === 'start' ? 'absolute inset-y-0 start-0 z-20 flex w-80 max-w-[85vw] shadow-2xl' : 'hidden'} flex-col border-e border-border bg-card lg:static lg:flex lg:w-72 lg:shadow-none`}
        >
          {startPane}
        </aside>
        {/* the target of the admin shell's skip link ("skip to main content"): the preview */}
        <main id="admin-main-content" tabIndex={-1} className="min-w-0 flex-1 outline-none">
          <Canvas
            storefrontUrl={getStoreHref(store)}
            path={canvasPath}
            token={token}
            doc={lookPreview?.draft ?? patchPreview?.candidate ?? b.doc}
            viewport={viewport}
            selectedId={selection?.sectionId ?? null}
            selectedBlockId={selection?.blockId ?? null}
            reloadKey={reloadKey}
            focusRequest={focusRequest}
            onMessage={onCanvasMessage}
          />
        </main>
        <aside
          ref={endRef}
          id="builder-settings"
          tabIndex={-1}
          aria-label={t('panes.end')}
          className={`${drawer === 'end' ? 'absolute inset-y-0 end-0 z-20 flex w-80 max-w-[85vw] shadow-2xl' : 'hidden'} flex-col border-s border-border bg-card lg:static lg:flex lg:w-80 lg:shadow-none`}
        >
          {endPane}
        </aside>
      </div>

      {pending && (
        <ConfirmDialog
          title={t('canvasOps.removeTitle', { name: pending.name })}
          body={t('canvasOps.removeBody')}
          confirmLabel={t('canvasOps.removeConfirm')}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            dispatch(pending.intent.action, pending.intent.coalesce);
            setPending(null);
          }}
        />
      )}

      {mediaReq && (
        <ImageSwapDialog
          storeId={storeId}
          request={mediaReq}
          hint={
            mediaReq.target.standard
              ? recommendedSizeTextForTemplateI18n(
                  mediaReq.target.standard,
                  (store?.template as TemplateId | undefined) ?? undefined,
                  locale === 'ar' ? 'ar' : 'en'
                )
              : undefined
          }
          onClose={() => setMediaReq(null)}
          onApply={(url, alt) => {
            // One coalesce key: the picture and its description are ONE undo step.
            for (const i of imageSwapActions(mediaReq, url, alt, swapSeq.current++))
              dispatch(i.action, i.coalesce);
            setMediaReq(null);
          }}
        />
      )}

      {addTo && (
        <AddSectionDialog
          list={addTo}
          doc={b.doc}
          template={store.template ? normalizeLegacyTemplate(store.template) : undefined}
          look={store.look}
          onClose={() => {
            setAddTo(null);
            setAddAt(undefined);
          }}
          onPick={(sectionType, presetIndex) => {
            dispatch({ type: 'addSection', list: addTo, sectionType, presetIndex, index: addAt });
            setAddTo(null);
            setAddAt(undefined);
          }}
        />
      )}
    </div>
  );
}
