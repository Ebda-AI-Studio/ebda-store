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
 * A bare label under `.ebda.app` (e.g. `crm`, `erp`, `wa`, `app`, `ab`) that no Worker serves, or `null`
 * for anything else (IPs, junk, multi-label names, other zones), which stay a plain 404.
 */
export function studioLabel(hostname: string): string | null {
  const host = hostname.split(':')[0].toLowerCase().replace(/\.$/, '');
  const suffix = BRAND.domains.storeSuffix;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null;
}

/** The branded studio response for a host nobody serves, or `null` when it is not a studio label. */
export function studioHostResponse(
  hostname: string,
  acceptLanguage: string | null,
  queryLang: string | null
): { response: NextResponse; plan: StudioHostPlan } | null {
  const label = studioLabel(hostname);
  if (label === null) return null;
  const plan = studioHostPlan(label);
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
