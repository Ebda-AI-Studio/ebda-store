'use client';

/**
 * Editor state for the visual builder (Phase 2): the document with undo/redo,
 * DRAFT AUTOSAVE against the optimistic-concurrency API, publish, and the
 * conflict state. One writer: every change goes through `dispatch`, which
 * runs the pure registry-checked reducer from @force/shared.
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
} from '@force/shared';
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

export function useBuilderDocument(storeId: string) {
  const base = `/api/v1/admin/stores/${storeId}/builder/pages/${HOME_PAGE}`;
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
  // The tail of every save requested so far (autosave AND flush/publish):
  // the single-flight queue bug fix below (REV_CONFLICT false positive).
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

  // Single-flight save queue: EVERY save request (autosave timer AND
  // flush/publish) chains onto the SAME `pendingSave` tail instead of ever
  // firing concurrently. Two concurrent `PUT …/draft` calls would both read
  // the SAME stale `revRef.current` as their `baseRev` (the first hasn't
  // resolved yet to bump it), so the second always loses to the first with a
  // 409 REV_CONFLICT — a false "another editor changed this page" on a slow
  // network, caused entirely by the client's own un-sequenced saves.
  // Chaining with `.then(run, run)` defers reading `revRef.current` until
  // the queued save actually runs, by which point the save ahead of it has
  // already updated it (`saveNow` sets `revRef.current` synchronously before
  // resolving) — so the queued save's `baseRev` is always fresh.
  const enqueueSave = useCallback(
    (definition: PageDefinition): Promise<boolean> => {
      const run = (): Promise<boolean> =>
        saveStateRef.current === 'conflict'
          ? Promise.resolve(false)
          : saveNow(definition, revRef.current);
      const next = (pendingSave.current ?? Promise.resolve(true)).then(run, run);
      pendingSave.current = next;
      void next.finally(() => {
        if (pendingSave.current === next) pendingSave.current = null;
      });
      return next;
    },
    [saveNow]
  );

  // Autosave: debounce after the last edit; never while a conflict is open.
  useEffect(() => {
    if (!doc || doc === savedRef.current) return;
    if (saveState === 'conflict' || saveState === 'loading') return;
    setSaveState(s => (s === 'saving' ? s : 'dirty'));
    const timer = window.setTimeout(() => void enqueueSave(doc), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saveState transitions must not re-arm the timer
  }, [doc, enqueueSave]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (pendingSave.current) await pendingSave.current;
    if (doc && doc !== savedRef.current && saveStateRef.current !== 'conflict')
      return enqueueSave(doc);
    return saveStateRef.current !== 'conflict' && saveStateRef.current !== 'error';
  }, [doc, enqueueSave]);

  const publish = useCallback(async (): Promise<'ok' | 'failed' | 'conflict'> => {
    setPublishing(true);
    try {
      if (!(await flush())) return saveStateRef.current === 'conflict' ? 'conflict' : 'failed';
      const res = await apiPost<{ rev: number }>(`${base}/publish`, { baseRev: revRef.current });
      if (res.error) {
        if (res.error.code === 'REV_CONFLICT') {
          setConflict((res.error.details as { latest?: PageState } | undefined)?.latest ?? null);
          setSaveState('conflict');
          return 'conflict';
        }
        // Nothing to publish: the draft equals what is live.
        if (res.error.code === 'NO_DRAFT') return 'ok';
        return 'failed';
      }
      setPublishedRev(res.data!.rev);
      return 'ok';
    } finally {
      setPublishing(false);
    }
  }, [base, flush]);

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
    setRev(latestRev);
    revRef.current = latestRev;
    await saveNow(doc, latestRev);
  }, [conflict, doc, saveNow]);

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
    canUndo: (history?.past.length ?? 0) > 0,
    canRedo: (history?.future.length ?? 0) > 0,
    dispatch,
    undo,
    redo,
    replaceDocument,
    publish,
    takeTheirs,
    keepMine,
    reload: load,
  };
}

export type BuilderDocument = ReturnType<typeof useBuilderDocument>;
