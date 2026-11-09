import { BRAND } from '@ebda/shared/brand';
import type { LineId } from './service-lines-content';

/**
 * The ONE flag for the studio's service lines (Ruling SERVICES-IA-1): the Services nav item, `/services` (+ `/en/services`) and the
 * three line pages `/services/{marketing,design,events}`. Read at BUILD time (`next build` exports static files), from the env var
 * `EBDA_SERVICE_LINES`:
 *
 *  - unset / `off` (the default, and what production builds): NOTHING exists. No page is exported (a visit gets the site 404), the
 *    nav has no Services item, the sitemap, llms.txt and the Organization JSON-LD do not mention the lines, and the contact form
 *    does not list the three line topics.
 *  - `preview`: the pages ARE exported so Ahmad can read them (direct URLs only), but they stay `noindex, nofollow`, out of the nav,
 *    the sitemap, llms.txt, JSON-LD and the search index. The contact form lists the line topics so the CTA can be tried. Use it on a
 *    preview deploy (a Worker version that is never promoted) or `npm run build:preview -w apps/marketing`.
 *  - `on` (alias `1`, `true`): publish. Nav + pages + sitemap + llms.txt + JSON-LD all appear together, indexable.
 *
 * Why 404 and not a redirect when off: the pages are unapproved copy, so there must be nothing at the URL to find, cache or index
 * (a redirect would also publish the URL's existence and could be cached by clients/CDNs after go-live). Cost if wrong: none; a
 * visitor who guesses the URL sees the normal not-found page, same as any unknown path.
 */
export type ServiceLinesMode = 'off' | 'preview' | 'on';

export function parseServiceLinesMode(raw: string | undefined): ServiceLinesMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'on' || v === '1' || v === 'true') return 'on';
  if (v === 'preview') return 'preview';
  return 'off';
}

export const SERVICE_LINES_ENV = 'EBDA_SERVICE_LINES';
export const serviceLinesMode = (): ServiceLinesMode =>
  parseServiceLinesMode(process.env[SERVICE_LINES_ENV]);
/** Pages exist at all (preview or on). */
export const serviceLinesBuilt = () => serviceLinesMode() !== 'off';
/** Public: nav, sitemap, llms.txt, JSON-LD, indexable. */
export const serviceLinesPublished = () => serviceLinesMode() === 'on';

export const SERVICE_LINE_IDS = BRAND.serviceLines.map(l => l.id) as LineId[];
export const isLineId = (s: string): s is LineId => (SERVICE_LINE_IDS as string[]).includes(s);
