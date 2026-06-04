import { cookies, headers } from 'next/headers';

/**
 * Read the page-builder preview-draft token. The middleware sets the
 * `x-preview-draft` header on the FIRST iframe load (`?_layoutDraft=`), and a
 * `force-preview-draft` cookie covers subsequent navigations within the iframe.
 * Mirrors the logic in app/layout.tsx so non-home pages (PLP / PDP) can resolve
 * the same draft and the page-builder "preview unsaved changes" reflects their
 * layout settings (products-page bg, PDP image aspect, card defaults, filters).
 */
export async function getPreviewDraftToken(): Promise<string | undefined> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  return h.get('x-preview-draft') ?? c.get('force-preview-draft')?.value ?? undefined;
}

/** Public layout endpoint URL, draft-aware. With a token the API returns the
 *  unsaved draft layout from Redis instead of the committed DB layout. */
export function publicLayoutUrl(apiUrl: string, storeId: string, draftToken?: string): string {
  const base = `${apiUrl}/public/stores/${storeId}/layout`;
  return draftToken ? `${base}?_layoutDraft=${encodeURIComponent(draftToken)}` : base;
}
