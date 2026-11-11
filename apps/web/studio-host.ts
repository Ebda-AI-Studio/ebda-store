import { NextResponse } from 'next/server';
import {
  BRAND,
  pickStudioLang,
  renderStudioPage,
  STUDIO_PAGE_HEADERS,
  studioHostPlan,
  type StudioHostPlan,
} from '@ebda/shared';

/**
 * A bare label under `.ebda.app` (e.g. `crm`, `erp`, `whatsapp`, `app`, `ab`) that no Worker serves, or `null`
 * for anything else (IPs, junk, multi-label names, other zones), which stay a plain 404.
 */
export function studioLabel(hostname: string): string | null {
  const host = hostname.split(':')[0].toLowerCase().replace(/\.$/, '');
  const suffix = BRAND.domains.storeSuffix;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null;
}

/**
 * The redirect target on `host`, built so the request can only supply a path and a query, never an origin: the URL
 * starts from `https://<host>/`, the path is set through the `pathname` setter after collapsing any leading `/` or
 * `\` run (so `//evil.com`, `/\evil.com` stay paths on `host`), and the host is checked again before answering.
 * Anything that does not stay on `host` falls back to its root. Not an open redirect (Ruling WHATSAPP-HOST-REDIRECT-1).
 */
export function redirectTarget(host: string, pathname: string, search: string): string {
  const root = `https://${host}/`;
  try {
    const u = new URL(root);
    u.pathname = '/' + pathname.replace(/^[/\\]+/, '');
    u.search = search;
    return u.host === host && u.protocol === 'https:' ? u.toString() : root;
  } catch {
    return root;
  }
}

/**
 * The branded studio response for a host nobody serves, or `null` when it is not a studio label. A label that
 * names a live product elsewhere (`whatsapp` → wa.ebda.app) is a 301 there, keeping the path and query; the target
 * host is FIXED (see `redirectTarget`), so a request path can never steer the redirect to another site.
 */
export function studioHostResponse(
  hostname: string,
  acceptLanguage: string | null,
  queryLang: string | null,
  pathname = '/',
  search = ''
): { response: NextResponse; plan: StudioHostPlan } | null {
  const label = studioLabel(hostname);
  if (label === null) return null;
  const plan = studioHostPlan(label);
  if (plan.kind === 'redirect') {
    const response = new NextResponse(null, {
      status: 301,
      headers: {
        Location: redirectTarget(plan.host, pathname, search),
        'Cache-Control': 'no-store',
      },
    });
    return { response, plan };
  }
  const html = renderStudioPage({
    lang: pickStudioLang(acceptLanguage, queryLang),
    kind: plan.kind,
    product: plan.product,
  });
  const response = new NextResponse(html, {
    status: plan.status,
    headers: STUDIO_PAGE_HEADERS,
  });
  return { response, plan };
}
