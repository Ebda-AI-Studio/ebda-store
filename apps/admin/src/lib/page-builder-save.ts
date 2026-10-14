/**
 * Page-builder Save through the visual builder's draft/publish API
 * (Phase 1). The existing page-builder UI keeps its look and its one Save
 * button; underneath, a save is now:
 *
 *   PUT  /builder/pages/home/draft    { baseRev, definition }  -> { rev }
 *   POST /builder/pages/home/publish  { baseRev: rev }         -> { rev }
 *
 * so every save is a revision (history + rollback) and two tabs can no
 * longer clobber each other: a stale `baseRev` comes back 409 REV_CONFLICT.
 *
 * `baseRev === null` means the API predates the builder routes (the admin
 * Worker and the Railway API deploy separately): the caller then falls back
 * to the legacy `PUT /layout`, so a deploy-order gap never breaks Save.
 */
import {
  layoutToDefinition,
  mergeDocumentOnlySections,
  type PageDefinition,
  type StoreLayoutSettings,
} from '@ebda/shared';
import { apiGet, apiPost, apiPut, type ApiError } from './api';

export const HOME_PAGE = 'home';

const base = (storeId: string) => `/api/v1/admin/stores/${storeId}/builder/pages/${HOME_PAGE}`;

/** Head rev of the homepage document, or null when the builder API is not there (404/older API). */
export async function loadPageRev(storeId: string): Promise<number | null> {
  const res = await apiGet<{ rev: number }>(base(storeId));
  if (res.error || typeof res.data?.rev !== 'number') return null;
  return res.data.rev;
}

export type PageSaveResult =
  | { ok: true; rev: number }
  /** `rev`: the rev to name next time (the saved draft's, when only publish failed). */
  | { ok: false; conflict: boolean; error: ApiError; rev: number };

export async function saveLayoutAsPage(
  storeId: string,
  layout: StoreLayoutSettings,
  baseRev: number
): Promise<PageSaveResult> {
  // The layout knows nothing about document-only sections (image-text,
  // newsletter — added in the new builder): carry them over from the current
  // document, or this legacy Save would delete them.
  const current = await apiGet<{ definition: PageDefinition }>(base(storeId));
  const definition = mergeDocumentOnlySections(
    layoutToDefinition(layout, HOME_PAGE),
    current.data?.definition
  );
  const draft = await apiPut<{ rev: number }>(`${base(storeId)}/draft`, { baseRev, definition });
  if (draft.error || !draft.data) {
    const error = draft.error ?? { code: 'SERVER_ERROR', message: 'Save failed', status: 0 };
    return { ok: false, conflict: error.code === 'REV_CONFLICT', error, rev: baseRev };
  }
  const draftRev = draft.data.rev;
  const pub = await apiPost<{ rev: number }>(`${base(storeId)}/publish`, { baseRev: draftRev });
  if (pub.error || !pub.data) {
    const error = pub.error ?? { code: 'SERVER_ERROR', message: 'Publish failed', status: 0 };
    // The draft IS saved: name its rev next time so a retry publishes it.
    return { ok: false, conflict: error.code === 'REV_CONFLICT', error, rev: draftRev };
  }
  return { ok: true, rev: pub.data.rev };
}
