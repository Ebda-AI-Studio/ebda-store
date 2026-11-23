/**
 * Ebda AI Studio's own "this address has nothing for you" pages: the Apple-style 404, the "coming soon" page for every coming-soon software
 * product (crm, erp: ONE template, only the copy differs, Ruling SUBDOMAIN-SOON-2) and the "reserved" page (hub, id).
 *
 * The renderer, its copy and its CSS live in the foundation (`foundation/studio-pages.ts`, F8) so every Ebda product serves the same shell; this
 * module binds it to the Store's BRAND (domains, colours, coming-soon products, support email, brand mark) and keeps the exports and types the
 * store Worker's middleware, the marketing build, accounts and the status Worker already import. Output is byte-identical to the renderer it
 * replaced (tests/unit/studio-pages-foundation.test.ts).
 */
import { BRAND, brandMarkSvg } from '../brand';
import {
  createStudioPages,
  HSTS_VALUE,
  pickStudioLang,
  type StudioLang,
  type StudioPageKind,
} from '../foundation/studio-pages';

export { HSTS_VALUE, pickStudioLang };
export type { StudioLang, StudioPageKind };
/** A coming-soon software product, by its `BRAND.comingProducts` id (the single source of its names and one-line description). */
export type ComingSoonProductId = (typeof BRAND.comingProducts)[number]['id'];
/** Which upcoming product a coming-soon page names; `reserved` = an address held for a future service. */
export type ComingSoonProduct = ComingSoonProductId | 'reserved';

export interface StudioPageInput {
  lang: StudioLang;
  kind: StudioPageKind;
  product?: ComingSoonProduct;
}

export type StudioHostPlan =
  | { status: 200 | 404; kind: StudioPageKind; product?: ComingSoonProduct }
  /** a label that names a LIVE product on another host: a permanent redirect there (path and query kept) */
  | { status: 301; kind: 'redirect'; host: string };

const studio = createStudioPages(BRAND, brandMarkSvg);

/** The page, as a complete HTML document string. */
export const renderStudioPage: (input: StudioPageInput) => string = studio.renderStudioPage;
/**
 * What a bare label under `.ebda.app` (a reserved or malformed one that no Worker serves) should show:
 * a live product's other name redirects to it; the named upcoming products answer 200 "coming soon";
 * everything else is a real 404.
 */
export const studioHostPlan = studio.studioHostPlan as (label: string) => StudioHostPlan;
/** Response headers for a studio page: not cacheable, noindex, and a locked-down CSP. */
export const STUDIO_PAGE_HEADERS: Readonly<Record<string, string>> = studio.STUDIO_PAGE_HEADERS;
/** Every label that answers a coming-soon page (for tests and the reserved-slug parity check). */
export const STUDIO_COMING_SOON_LABELS: readonly string[] = studio.STUDIO_COMING_SOON_LABELS;
/** Every label that redirects to a live product elsewhere. */
export const STUDIO_REDIRECT_LABELS: readonly string[] = studio.STUDIO_REDIRECT_LABELS;
