import { pageDefinitionSchema, type PageDefinition, type SectionPageKind } from '@ebda/shared';
import { API_URL } from './api';

/**
 * The section document of a product / collection / cart page (Ruling VE-3 amended), fetched on the
 * server so the first paint already has the merchant's section order.
 *
 * - Public visit: the PUBLISHED document (or the default one the API synthesizes), cached 60 s and
 *   tagged `layout:<storeId>`, the tag every publish already purges.
 * - Editor canvas (`?_preview&_builder=<token>`): the working DRAFT for that token, never cached. A token
 *   minted for another page is ignored, so a product canvas can never render a cart document.
 * - Any failure returns `undefined` and the page renders in today's order: a missing document must
 *   never turn a product page into an error.
 */
export interface PageDocumentResult {
  definition: PageDefinition;
  /** True only for a valid draft served to the editor canvas. */
  editorMode: boolean;
}

function parse(raw: unknown, kind: SectionPageKind): PageDefinition | undefined {
  const parsed = pageDefinitionSchema.safeParse(raw);
  return parsed.success && parsed.data.pageKey === kind ? parsed.data : undefined;
}

export async function fetchPageDocument(
  storeId: string,
  kind: SectionPageKind,
  builderToken?: string
): Promise<PageDocumentResult | undefined> {
  if (!storeId || storeId === 'demo') return undefined;
  try {
    if (builderToken) {
      const res = await fetch(
        `${API_URL}/public/stores/${storeId}/builder-preview?token=${encodeURIComponent(builderToken)}`,
        { cache: 'no-store' }
      );
      if (res.ok) {
        const definition = parse((await res.json())?.data?.definition, kind);
        if (definition) return { definition, editorMode: true };
      }
      // an invalid token or another page's token: fall through to the published document
    }
    const res = await fetch(`${API_URL}/public/stores/${storeId}/pages/${kind}`, {
      next: { revalidate: 60, tags: [`layout:${storeId}`] },
    });
    if (!res.ok) return undefined;
    const definition = parse((await res.json())?.data?.definition, kind);
    return definition ? { definition, editorMode: false } : undefined;
  } catch {
    return undefined;
  }
}

/** `?_builder=` counts only inside the admin preview iframe (`?_preview`), like the home page. */
export function builderTokenFrom(
  params: Record<string, string | string[] | undefined>
): string | undefined {
  const t = params._builder;
  return typeof t === 'string' && t.length > 0 && '_preview' in params ? t : undefined;
}
