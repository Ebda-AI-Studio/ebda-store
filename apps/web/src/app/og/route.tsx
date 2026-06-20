/**
 * Store-aware Open Graph card generator (1200×630) — `GET /og?slug=<slug>`.
 *
 * Replaces the old file-convention `app/opengraph-image.tsx`. That special file
 * was served at a fixed `/opengraph-image` URL with NO way to carry the store
 * identity, so for path-based storefronts (`store.forcemediakw.com/<slug>`)
 * WhatsApp fetched `…/opengraph-image` with no `/<slug>` context and the route
 * resolved to the PLATFORM-DEFAULT store — every path-based store's link
 * preview showed the generic "Force" card instead of the merchant's branding.
 *
 * This route takes the store identity explicitly via `?slug=`, so the card
 * always renders the correct store. When no slug is supplied (custom-domain
 * stores resolve by Host header) it falls back to the request-context store.
 *
 * Design (unchanged from the previous card):
 *   - Background: store's primary brand color (theme.primaryColor HSL or orange)
 *   - Centered: store logo (store.ogImage / store.logo) up to 420×220, raster or
 *     SVG-rasterized-via-sharp; falls back to the store name in large text
 *   - Store name badge at the bottom
 *
 * Cached: ImageResponse routes are cached by Next; store data is fetched with a
 * short revalidate so a logo/name change reflects within ~a minute. After a logo
 * change, force a fresh scrape via the Facebook Sharing Debugger (WhatsApp caches
 * OG images aggressively).
 */

import { ImageResponse } from 'next/og';
import { getStore, resolveStoreBySlug, type ResolvedStore } from '../../lib/store-resolver';

// node runtime (NOT edge): on Vercel/Node we rasterize SVG store logos to PNG
// (via a runtime-gated dynamic `sharp` import) so the card can <img> them —
// Satori (the ImageResponse renderer) cannot render an SVG <img> source, which
// is why an SVG logo previously showed the store name instead of the logo.
//
// Cloudflare/Workers note: `sharp` is a native module that cannot run on
// Workers. The import is dynamic + gated on isCloudflareRuntime() — the
// OpenNext build marks `sharp` external, and SVG logos gracefully fall back to
// the branded name card there. Raster logos + the name-card path render
// identically on both. No Vercel regression.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIZE = { width: 1200, height: 630 };

/** True under Cloudflare (OpenNext) rather than Vercel/Node. */
function isCloudflareRuntime(): boolean {
  return !!process.env.OPEN_NEXT_CLOUDFLARE || !!process.env.CF_PAGES;
}

/** Rasterize an SVG buffer to a PNG data URI via sharp on Node. Returns null on
 *  Cloudflare (sharp is native → Workers-incompatible) or any failure, so the
 *  caller falls back to the branded name card. */
async function rasterizeSvgToPng(svgBuf: Buffer): Promise<string | null> {
  if (isCloudflareRuntime()) return null;
  try {
    // Non-literal specifier: the Cloudflare bundler can't statically resolve a
    // computed import, so it leaves `sharp` as a runtime require rather than
    // bundling the native binary. Unreachable on Workers (guard above).
    const sharpModule = ['sh', 'arp'].join('');
    const sharp = (await import(/* webpackIgnore: true */ sharpModule)).default;
    const png = await sharp(svgBuf, { density: 240 })
      .resize(600, 600, { fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * SSRF guard for the on-the-fly SVG rasterizer. Store logo/ogImage URLs are
 * tenant-controlled and this route runs server-side, so we must NEVER fetch an
 * arbitrary URL (could hit internal/metadata endpoints). Only allow https URLs
 * on the known public asset CDN (Cloudflare R2 `*.r2.dev`).
 */
function isAllowedAssetUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /(^|\.)r2\.dev$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** "H S% L%" → "hsl(H, S%, L%)"; pass-through for "#hex"; orange fallback. */
function hslComponentsToCss(hslComponents: string | undefined): string {
  if (!hslComponents) return 'hsl(26, 100%, 50%)';
  if (hslComponents.startsWith('#')) return hslComponents;
  const match = hslComponents.match(/^([\d.]+)\s+([\d.]+%)\s+([\d.]+%)/);
  if (match) return `hsl(${match[1]}, ${match[2]}, ${match[3]})`;
  return 'hsl(26, 100%, 50%)';
}

/** Lighten an HSL component string toward white for the background gradient. */
function lightenHsl(hslComponents: string | undefined, lightenBy = 15): string {
  if (!hslComponents || hslComponents.startsWith('#')) return 'hsl(26, 100%, 65%)';
  const match = hslComponents.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (!match) return 'hsl(26, 100%, 65%)';
  const h = match[1];
  const s = match[2];
  const l = Math.min(95, parseFloat(match[3]) + lightenBy);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

/** Resolve a RASTER logo URL the OG card can <img>. Raster passes through; an
 *  SVG on the allowed CDN is fetched + rasterized; anything else → null (name
 *  card). */
async function resolveLogoUrl(store: ResolvedStore): Promise<string | null> {
  const candidate = store.ogImage || store.logo || null;
  if (!candidate) return null;
  if (/\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(candidate)) return candidate;
  if (/\.svg(\?|#|$)/i.test(candidate) && isAllowedAssetUrl(candidate)) {
    try {
      const res = await fetch(candidate, { next: { revalidate: 3600 }, redirect: 'error' });
      if (res.ok) {
        const svgBuf = Buffer.from(await res.arrayBuffer());
        return await rasterizeSvgToPng(svgBuf);
      }
    } catch {
      return null;
    }
  }
  return null;
}

export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get('slug');
  // Slug wins (path-based stores); fall back to header-resolved store (custom
  // domains) or the platform default so the route never throws.
  const store = (slug ? await resolveStoreBySlug(slug) : null) ?? (await getStore());

  const primaryHsl = (store.theme as unknown as Record<string, unknown>)?.primaryColor as
    | string
    | undefined;
  const bgColor = hslComponentsToCss(primaryHsl);
  const bgLight = lightenHsl(primaryHsl, 20);
  const logoUrl = await resolveLogoUrl(store);
  const storeName = store.name || 'Store';

  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        width: '1200px',
        height: '630px',
        background: `linear-gradient(135deg, ${bgColor} 0%, ${bgLight} 100%)`,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        position: 'relative',
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.08)',
          backgroundImage:
            'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.12) 0%, transparent 50%)',
        }}
      />

      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt={storeName}
          style={{
            maxWidth: '420px',
            maxHeight: '220px',
            objectFit: 'contain',
            borderRadius: '16px',
            backgroundColor: 'rgba(255,255,255,0.95)',
            padding: '24px 32px',
            boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
          }}
        />
      ) : (
        <div
          style={{
            display: 'flex',
            color: '#ffffff',
            fontSize: '80px',
            fontWeight: 700,
            textShadow: '0 4px 16px rgba(0,0,0,0.3)',
            textAlign: 'center',
            padding: '0 60px',
            maxWidth: '1000px',
            wordBreak: 'break-word',
          }}
        >
          {storeName}
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          bottom: '40px',
          display: 'flex',
          alignItems: 'center',
          backgroundColor: 'rgba(0,0,0,0.35)',
          color: '#ffffff',
          fontSize: '28px',
          fontWeight: 600,
          padding: '12px 32px',
          borderRadius: '999px',
          backdropFilter: 'blur(8px)',
        }}
      >
        {storeName}
      </div>
    </div>,
    { ...SIZE }
  );
}
