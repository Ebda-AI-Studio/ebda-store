import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { API_URL } from '../../../lib/api';
import { qrUtm } from '@ebda/shared/qr/links';
import type { QrKind } from '@ebda/shared/qr/schema';

/**
 * Printed QR codes land here (QR-1): `/q/s` store, `/q/w` WhatsApp chat, `/q/p/<slug>` product,
 * `/q/c/<slug>` category. Stateless: the API resolves the target and counts the scan
 * (GET /public/qr/scan), then the shopper is 302'd to the store page with utm_source=qr so the
 * merchant's own analytics attribute it. Never cached: a cached redirect would skip the count.
 * The store comes from the Host only (middleware sets x-store-domain); a platform host or an
 * unknown store is a 404.
 */
const KIND_BY_SEGMENT: Record<string, QrKind> = {
  s: 'store',
  w: 'whatsapp',
  p: 'product',
  c: 'category',
};

function notFound(): NextResponse {
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Pure mapping used by the handler and its tests. */
export function parseQrPath(parts: string[] | undefined): { kind: QrKind; slug?: string } | null {
  if (!parts || parts.length === 0 || parts.length > 2) return null;
  const kind = KIND_BY_SEGMENT[parts[0]];
  if (!kind) return null;
  const needsSlug = kind === 'product' || kind === 'category';
  if (needsSlug !== (parts.length === 2)) return null;
  return needsSlug ? { kind, slug: safeDecode(parts[1]) } : { kind };
}

/** Builds the redirect location from the API's `target` (relative store path or wa.me URL). */
export function qrLocation(target: string, kind: QrKind, origin: string): string | null {
  if (kind === 'whatsapp') {
    return target.startsWith('https://wa.me/') ? target : null;
  }
  if (!target.startsWith('/') || target.startsWith('//')) return null;
  const url = new URL(target, origin);
  for (const [k, v] of new URLSearchParams(qrUtm(kind))) url.searchParams.set(k, v);
  return url.toString();
}

export async function GET(_req: Request, ctx: { params: Promise<{ parts?: string[] }> }) {
  const { parts } = await ctx.params;
  const parsed = parseQrPath(parts);
  if (!parsed) return notFound();

  const host = (await headers()).get('x-store-domain');
  if (!host) return notFound();

  const qs = new URLSearchParams({
    kind: parsed.kind,
    ...(parsed.slug ? { slug: parsed.slug } : {}),
  });
  let target: string | null = null;
  try {
    const res = await fetch(`${API_URL}/public/qr/scan?${qs}`, {
      cache: 'no-store',
      headers: { 'x-store-domain': host },
    });
    if (!res.ok) return notFound();
    const json = await res.json();
    target = typeof json?.data?.target === 'string' ? json.data.target : null;
  } catch {
    return notFound();
  }
  if (!target) return notFound();

  const origin = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
    ? `http://${host}`
    : `https://${host}`;
  const location = qrLocation(target, parsed.kind, origin);
  if (!location) return notFound();

  return new NextResponse(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}
