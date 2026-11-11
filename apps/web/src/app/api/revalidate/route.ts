import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { revalidateRequestSchema } from '@ebda/shared';

/**
 * On-demand storefront cache purge. The API (Railway) calls this after a
 * merchant saves theme / layout / branding so the change appears on the
 * storefront within ~a second instead of waiting out the data-cache TTL.
 *
 * The Worker entry (sentry-worker-entry.ts) bumps the per-store purge EPOCHS in R2
 * for these tags after this route accepts them; the store resolver's caches
 * (store-resolve-cache.ts, Ruling RESOLVE-BULLETPROOF-1) and the edge HTML cache
 * check those epochs before every serve. `revalidateTag` here is kept for the
 * other tagged fetches (production's deploy-generated open-next config runs the
 * DO-sharded tag cache; the committed local config has none).
 *
 * Auth: a shared `REVALIDATE_SECRET` (also set on the API). If the secret is
 * unset on this deployment, the route refuses (503) rather than purging
 * unauthenticated — it never silently accepts.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: 'REVALIDATE_SECRET not configured' },
      { status: 503 }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  // Valid JSON that is not an object (`null`, `[]`, `42`) used to throw a
  // TypeError on `body.secret` below and 500.
  const parsedBody = revalidateRequestSchema.safeParse(raw);
  if (!parsedBody.success) {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  const body = parsedBody.data;

  if (body.secret !== secret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length < 200)
    : [];
  if (tags.length === 0 || tags.length > 10) {
    return NextResponse.json({ ok: false, error: 'tags must be 1..10 strings' }, { status: 400 });
  }

  // Next 16 signature: revalidateTag(tag, profile). NOT 'max': that is stale-while-revalidate, so the FIRST
  // request after a merchant write was served the pre-write entry (a product page with no photo right after
  // upload, Amelia Aurum 2026-11-11) and only the background refresh was fresh. `{ expire: 0 }` expires the
  // tagged entries at once, so the next render refetches inline. Wrapped defensively so an evolving
  // cache-API quirk can never 500 this endpoint; the short fetch `revalidate` window is the floor either way.
  for (const tag of tags) {
    try {
      revalidateTag(tag, { expire: 0 });
    } catch (e) {
      console.warn('[revalidate] revalidateTag failed for', tag, e);
    }
  }
  return NextResponse.json({ ok: true, revalidated: tags });
}
