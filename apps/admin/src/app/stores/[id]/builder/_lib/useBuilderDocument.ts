'use client';

/**
 * Editor state for the visual builder (Phase 2): the document with undo/redo,
 * DRAFT AUTOSAVE against the optimistic-concurrency API, publish, and the
 * conflict state. One writer: every change goes through `dispatch`, which
 * runs the pure registry-checked reducer from @ebda/shared.
 *
 * Save model (same API as Phase 1):
 *   - edits debounce `AUTOSAVE_MS`, then `PUT …/draft { baseRev, definition }`;
 *   - a 409 REV_CONFLICT stops autosave and surfaces `conflict` with the
 *     server's latest document; the merchant CHOOSES: load theirs, or keep
 *     mine (an explicit overwrite at the new rev) — never silent;
 *   - a 422 keeps the edit and surfaces the field errors;
 *   - publish flushes the pending save, then `POST …/publish { baseRev }`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  pushHistory,
  undo as undoHistory,
  redo as redoHistory,
  resetHistory,
  reduceDocument,
  type BuilderIssue,
  type DocumentAction,
  type History,
  type PageDefinition,
} from '@ebda/shared';
import { apiGet, apiPost, apiPut } from '../../../../../lib/api';

export const AUTOSAVE_MS = 1200;
export const HOME_PAGE = 'home';

export type SaveState = 'loading' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface PageState {
  rev: number;
  definition: PageDefinition;
  source: 'draft' | 'published' | 'layout';
  draftRev: number | null;
  publishedRev: number | null;
}

/** Settings whose change needs the canvas to refetch data (new products, reviews). */
const DATA_KEYS = new Set([
  'productSource',
  'categorySlug',
  'manualProductIds',
  'limit',
  'categoryFetchLimit',
  'minRating',
  'verifiedOnly',
]);

export function needsDataReload(action: DocumentAction): boolean {
  if (action.type === 'setSectionSetting') return DATA_KEYS.has(action.key);
  if (action.type === 'addSection' || action.type === 'duplicateSection')
    return (
      action.type === 'duplicateSection' ||
      ['product-carousel', 'testimonials'].includes(action.sectionType)
    );
  return false;
}

export function useBuilderDocument(storeId: string, pageKey: string = HOME_PAGE) {
  const base = `/api/v1/admin/stores/${storeId}/builder/pages/${pageKey}`;
  const [history, setHistoryState] = useState<History<PageDefinition> | null>(null);
  // The ref is the source of truth between renders, so two dispatches in one
  // tick both see the latest document (a setState updater runs later).
  const historyRef = useRef<History<PageDefinition> | null>(null);
  const setHistory = useCallback(
    (
      next:
        | History<PageDefinition>
        | null
        | ((h: History<PageDefinition> | null) => History<PageDefinition> | null)
    ) => {
      historyRef.current = typeof next === 'function' ? next(historyRef.current) : next;
      setHistoryState(historyRef.current);
    },
    []
  );
  const [rev, setRev] = useState(0);
  const [publishedRev, setPublishedRev] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [errors, setErrors] = useState<BuilderIssue[]>([]);
  const [conflict, setConflict] = useState<PageState | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [dataEpoch, setDataEpoch] = useState(0);
  const savedRef = useRef<PageDefinition | null>(null);
  const revRef = useRef(0);
  // One queue owns draft saves AND publication so our own writes never race.
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const pendingReload = useRef(false);
  const saveStateRef = useRef<SaveState>('loading');
  revRef.current = rev;
  saveStateRef.current = saveState;

  const load = useCallback(async () => {
    setSaveState('loading');
    const res = await apiGet<PageState>(base);
    if (res.error || !res.data) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    savedRef.current = res.data.definition;
    setHistory(resetHistory(res.data.definition));
    setRev(res.data.rev);
    setPublishedRev(res.data.publishedRev);
    setConflict(null);
    setErrors([]);
    setSaveState('saved');
  }, [base, setHistory]);

  useEffect(() => {
    void load();
  }, [load]);

  const doc = history?.present ?? null;

  const dispatch = useCallback(
    (action: DocumentAction, coalesceKey?: string): ReturnType<typeof reduceDocument> | null => {
      const h = historyRef.current;
      if (!h) return null;
      const result = reduceDocument(h.present, action);
      if (result.rejected) return result;
      setHistory(pushHistory(h, result.doc, { coalesceKey }));
      if (needsDataReload(action)) pendingReload.current = true;
      return result;
    },
    [setHistory]
  );

  const undo = useCallback(() => setHistory(h => (h ? undoHistory(h) : h)), [setHistory]);
  const redo = useCallback(() => setHistory(h => (h ? redoHistory(h) : h)), [setHistory]);

  /** Replace the whole document as ONE undo step (template family preset). */
  const replaceDocument = useCallback(
    (next: PageDefinition) => {
      setHistory(h => (h ? pushHistory(h, next) : h));
      pendingReload.current = true;
    },
    [setHistory]
  );

  /**
   * Edit the CURRENT document without reloading the canvas data (header/footer
   * links, text typing): autosave picks it up like any dispatch; `coalesceKey`
   * folds a burst of keystrokes into one undo step.
   */
  const patchDocument = useCallback(
    (fn: (doc: PageDefinition) => PageDefinition, coalesceKey?: string) => {
      setHistory(h => (h ? pushHistory(h, fn(h.present), { coalesceKey }) : h));
    },
    [setHistory]
  );

  const saveNow = useCallback(
    async (definition: PageDefinition, baseRev: number): Promise<boolean> => {
      setSaveState('saving');
      const res = await apiPut<{ rev: number; warnings: BuilderIssue[] }>(`${base}/draft`, {
        baseRev,
        definition,
      });
      if (res.error) {
        if (res.error.code === 'REV_CONFLICT') {
          const latest = (res.error.details as { latest?: PageState } | undefined)?.latest ?? null;
          setConflict(latest);
          setSaveState('conflict');
        } else {
          const errs = (res.error.details as { errors?: BuilderIssue[] } | undefined)?.errors ?? [];
          setErrors(errs);
          setSaveState('error');
        }
        return false;
      }
      savedRef.current = definition;
      setRev(res.data!.rev);
      revRef.current = res.data!.rev;
      setErrors([]);
      setSaveState(s => (s === 'saving' ? 'saved' : s));
      if (pendingReload.current) {
        pendingReload.current = false;
        setDataEpoch(e => e + 1);
      }
      return true;
    },
    [base]
  );

  const enqueueWrite = useCallback((run: () => Promise<boolean>): Promise<boolean> => {
    const next = (pendingSave.current ?? Promise.resolve(true)).then(run, run);
    pendingSave.current = next;
    const clear = () => {
      if (pendingSave.current === next) pendingSave.current = null;
    };
    void next.then(clear, clear);
    return next;
  }, []);

  // Read the current history when the queued write executes, not when it
  // was requested. Edits made during a slow save must never be overwritten
  // by an older captured snapshot. Keep saving until publication can use
  // the latest document; later autosaves wait behind the publish request.
  const saveLatest = useCallback(async (): Promise<boolean> => {
    if (saveStateRef.current === 'conflict') return false;
    let ok = saveStateRef.current !== 'error';
    let current = historyRef.current?.present;
    while (current && current !== savedRef.current) {
      if (!(await saveNow(current, revRef.current))) return false;
      ok = true;
      current = historyRef.current?.present;
    }
    return ok;
  }, [saveNow]);

  const enqueueSave = useCallback(() => enqueueWrite(saveLatest), [enqueueWrite, saveLatest]);

  // Autosave: debounce after the last edit; never while a conflict is open.
  useEffect(() => {
    if (!doc || doc === savedRef.current) return;
    if (saveState === 'conflict' || saveState === 'loading') return;
    setSaveState(s => (s === 'saving' ? s : 'dirty'));
    const timer = window.setTimeout(() => void enqueueSave(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saveState transitions must not re-arm the timer
  }, [doc, enqueueSave]);

  const publish = useCallback(async (): Promise<'ok' | 'failed' | 'conflict'> => {
    setPublishing(true);
    try {
      let outcome: 'ok' | 'failed' | 'conflict' = 'failed';
      await enqueueWrite(async () => {
        if (!(await saveLatest())) {
          outcome = saveStateRef.current === 'conflict' ? 'conflict' : 'failed';
          return false;
        }
        const res = await apiPost<{ rev: number }>(`${base}/publish`, { baseRev: revRef.current });
        if (res.error) {
          if (res.error.code === 'REV_CONFLICT') {
            setConflict((res.error.details as { latest?: PageState } | undefined)?.latest ?? null);
            setSaveState('conflict');
            outcome = 'conflict';
            return false;
          }
          // Nothing to publish: the draft equals what is live.
          if (res.error.code === 'NO_DRAFT') {
            outcome = 'ok';
            return true;
          }
          // e.g. INVALID_DEFINITION / MISSING_IMAGE: the draft saved fine (it's
          // allowed to be incomplete) but isn't publish-ready. Surface the same
          // field-level errors saveNow's own 422 path sets, so SettingsPanel
          // highlights the exact slide/field instead of a bare "publish failed"
          // toast with no indication of what to fix.
          const errs = (res.error.details as { errors?: BuilderIssue[] } | undefined)?.errors ?? [];
          if (errs.length > 0) setErrors(errs);
          setSaveState('error');
          return false;
        }
        setPublishedRev(res.data!.rev);
        outcome = 'ok';
        return true;
      });
      return outcome;
    } finally {
      setPublishing(false);
    }
  }, [base, enqueueWrite, saveLatest]);

  /** Conflict choice 1: drop my edits, open the server's latest. */
  const takeTheirs = useCallback(() => {
    if (!conflict) return void load();
    savedRef.current = conflict.definition;
    setHistory(resetHistory(conflict.definition));
    setRev(conflict.rev);
    setConflict(null);
    setSaveState('saved');
  }, [conflict, load, setHistory]);

  /** Conflict choice 2: keep mine — an explicit overwrite at the server's rev. */
  const keepMine = useCallback(async () => {
    if (!conflict || !doc) return;
    const latestRev = conflict.rev;
    setConflict(null);
    await enqueueWrite(async () => {
      setRev(latestRev);
      revRef.current = latestRev;
      return saveNow(historyRef.current?.present ?? doc, latestRev);
    });
  }, [conflict, doc, enqueueWrite, saveNow]);

  const dirty = !!doc && doc !== savedRef.current;

  return {
    doc,
    rev,
    publishedRev,
    saveState,
    errors,
    conflict,
    publishing,
    loadError,
    dataEpoch,
    dirty,
    /** Undo steps taken in this session: the publish popover's "N edits". */
    editCount: history?.past.length ?? 0,
    canUndo: (history?.past.length ?? 0) > 0,
    canRedo: (history?.future.length ?? 0) > 0,
    dispatch,
    undo,
    redo,
    replaceDocument,
    patchDocument,
    /** Flush the pending draft save now (queued behind any in-flight write). */
    saveDraftNow: enqueueSave,
    publish,
    takeTheirs,
    keepMine,
    reload: load,
  };
}

export type BuilderDocument = ReturnType<typeof useBuilderDocument>;
