/**
 * Per-store Open Graph image generator (1200×630).
 *
 * Next.js App Router special file — served at /opengraph-image by the framework.
 * Generates a branded social-preview card for every store so WhatsApp / iMessage /
 * Telegram / Slack link previews show the store's logo and name instead of a blank
 * placeholder.
 *
 * Design:
 *   - Background: store's primary brand color (from theme.primaryColor HSL or fallback orange)
 *   - Centered: store logo (from store.logo / store.ogImage) at up to 400×200px
 *   - Fallback (no logo): store name in large white text
 *   - Store name badge at bottom of card
 *
 * WhatsApp-specific requirements honoured:
 *   - Size is exactly 1200×630 (og:image:width + og:image:height emitted by layout.tsx)
 *   - URL is the canonical /opengraph-image route on the store's domain (absolute https)
 *   - No transparent backgrounds — opaque brand-color fill ensures a non-blank card
 *
 * Cached:
 *   - Next.js caches ImageResponse routes by default; store data is fetched with
 *     60s revalidation so a logo/name change is reflected within a minute.
 *
 * WhatsApp cache note:
 *   After deploying a logo change, test with the Facebook Sharing Debugger
 *   (https://developers.facebook.com/tools/debug/) to force-scrape a fresh preview.
 *   WhatsApp caches OG images aggressively — the debugger is the fastest way to bust
 *   the platform cache without waiting hours.
 */

import { ImageResponse } from 'next/og';
import sharp from 'sharp';
import { getStore } from '../lib/store-resolver';

// node runtime (NOT edge): sharp is a native module. We use it to rasterize SVG
// store logos to PNG on the fly so the OG card can <img> them — Satori (the
// ImageResponse renderer) cannot render an SVG <img> source, which is why the
// WhatsApp/social preview previously showed the store name instead of the logo.
export const runtime = 'nodejs';
export const contentType = 'image/png';
export const size = { width: 1200, height: 630 };

/**
 * Parse an HSL component string like "26 100% 50%" into a hex-style
 * color suitable for ImageResponse JSX. We convert to a CSS hsl() string
 * which Satori (ImageResponse's renderer) understands.
 *
 * Falls back to Force AI's brand orange when the value is malformed.
 */
function hslComponentsToCss(hslComponents: string | undefined): string {
  if (!hslComponents) return 'hsl(26, 100%, 50%)';
  // Accept both "26 100% 50%" and "#ff6e00" forms
  if (hslComponents.startsWith('#')) return hslComponents;
  // "H S% L%" → "hsl(H, S%, L%)"
  const match = hslComponents.match(/^([\d.]+)\s+([\d.]+%)\s+([\d.]+%)/);
  if (match) return `hsl(${match[1]}, ${match[2]}, ${match[3]})`;
  return 'hsl(26, 100%, 50%)';
}

/**
 * Lighten an HSL component string toward white for the background gradient.
 * Input: "26 100% 50%", lightenBy: 20 → "26 100% 70%"
 */
function lightenHsl(hslComponents: string | undefined, lightenBy = 15): string {
  if (!hslComponents || hslComponents.startsWith('#')) {
    return 'hsl(26, 100%, 65%)';
  }
  const match = hslComponents.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (!match) return 'hsl(26, 100%, 65%)';
  const h = match[1];
  const s = match[2];
  const l = Math.min(95, parseFloat(match[3]) + lightenBy);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

export default async function Image() {
  const store = await getStore();

  const primaryHsl = (store.theme as unknown as Record<string, unknown>)?.primaryColor as
    | string
    | undefined;
  const bgColor = hslComponentsToCss(primaryHsl);
  const bgLight = lightenHsl(primaryHsl, 20);

  // Prefer admin-configured OG image, then store logo. Both are absolute R2 URLs.
  // CRITICAL: Satori (ImageResponse's renderer) can only embed RASTER images in
  // <img> — an SVG src renders blank (this is why the WhatsApp preview showed no
  // logo: most store logos are SVG). So only use <img> for png/jpg/webp/gif; for
  // an SVG or unknown format, fall through to the branded store-name card, which
  // always renders and is a far better preview than a blank image.
  const candidate = store.ogImage || store.logo || null;
  // Resolve a RASTER logo the OG card can <img>. Raster URLs pass through;
  // an SVG is fetched + rasterized to a PNG data URI via sharp ("the FWB system
  // converts the SVG"); anything that fails falls through to the branded
  // store-name card (which always renders — never a blank preview).
  let logoUrl: string | null = null;
  if (candidate) {
    if (/\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(candidate)) {
      logoUrl = candidate;
    } else if (/\.svg(\?|#|$)/i.test(candidate)) {
      try {
        const res = await fetch(candidate, { next: { revalidate: 3600 } });
        if (res.ok) {
          const svgBuf = Buffer.from(await res.arrayBuffer());
          const png = await sharp(svgBuf, { density: 240 })
            .resize(600, 600, { fit: 'inside', withoutEnlargement: false })
            .png()
            .toBuffer();
          logoUrl = `data:image/png;base64,${png.toString('base64')}`;
        }
      } catch {
        logoUrl = null; // fall back to the name card
      }
    }
  }
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
      {/* Subtle overlay grid for depth */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.08)',
          backgroundImage:
            'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.12) 0%, transparent 50%)',
        }}
      />

      {/* Logo or store name text */}
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
            // White background behind the logo so transparent PNGs are readable
            // on any brand color — especially important for dark-on-transparent logos.
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

      {/* Store name badge at bottom */}
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
    {
      ...size,
    }
  );
}
