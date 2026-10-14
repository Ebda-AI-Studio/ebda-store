/**
 * Email-client-safe layout primitives shared by EVERY transactional email.
 *
 * Why this exists (2026-09-30, Demo Store invoice on the Gmail Android app):
 * Gmail, Outlook and most webmail clients drop or partially drop `<style>`
 * blocks — Gmail discards any rule it cannot parse (CSS custom properties,
 * `color-mix()`, space-separated `hsl()`), and a `<style>` nested in the body
 * is discarded outright. Anything sized only by a class then renders at its
 * NATURAL size: a 1600px logo scrolled sideways, a 1200×1600 product photo ran
 * several screens tall, and the invoice's print-page "PAID" watermark became a
 * loose line of text.
 *
 * The rule this module enforces: sizing, colour and alignment are carried by
 * inline `style` + HTML attributes only. A `<style>` block may never be what
 * keeps an email readable.
 */

/** The canonical email body width. Fluid below it (`width:100%;max-width`). */
import { BRAND } from '@ebda/shared';
export const EMAIL_MAX_WIDTH = 600;
/**
 * Store logo box: at most this wide AND at most EMAIL_LOGO_MAX_HEIGHT tall,
 * scaled proportionally into it (issue 2336). A wide wordmark hits the width
 * (1600×420 → 160×42); a square mark hits the height (800×800 → 64×64) instead
 * of rendering 160×160 — which pushed the order below the fold on merchant
 * alerts, the reason the old shell capped the logo at 56px.
 */
export const EMAIL_LOGO_WIDTH = 160;
export const EMAIL_LOGO_MAX_HEIGHT = 64;
/** Product thumbnails in item tables. */
export const EMAIL_THUMB_SIZE = 64;

/** Solid hex palette. No `var()`, no `hsl()`, no alpha: every client parses hex. */
export const EMAIL_COLORS = {
  ink: '#0f172a',
  inkSoft: '#475569',
  inkMute: '#94a3b8',
  line: '#e2e8f0',
  lineSoft: '#f1f5f9',
  bg: '#ffffff',
  bgSoft: '#f8fafc',
  success: '#166534',
  successBg: '#dcfce7',
  warning: '#854d0e',
  warningBg: '#fef9c3',
  danger: '#991b1b',
  dangerBg: '#fee2e2',
} as const;

export const EMAIL_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const EMAIL_FONT_AR = "Tahoma, 'Segoe UI', Arial, sans-serif";

export type EmailDir = 'ltr' | 'rtl';

/** Physical start/end sides for a direction — Outlook ignores `start`/`end`. */
export function emailSides(dir: EmailDir): { start: 'left' | 'right'; end: 'left' | 'right' } {
  return dir === 'rtl' ? { start: 'right', end: 'left' } : { start: 'left', end: 'right' };
}

function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * An `<img>` every client sizes correctly: a `width` HTML attribute (Outlook
 * desktop reads only that), the same width inline, `max-width:100%` so it can
 * never widen the column, and either a fixed `height` (thumbnails — square box)
 * or `height:auto` (logos — aspect ratio unknown, so a fixed height would
 * stretch them; the width attribute alone bounds them).
 *
 * `src`/`alt` are escaped here — callers pass raw values.
 */
export function emailImage(opts: {
  src: string;
  alt: string;
  width: number;
  /** Fixed box height. Omit for proportional (logo) images. */
  height?: number;
  /**
   * Proportional images only: also cap the height. The image then scales
   * WHOLE into a `width` × `maxHeight` box (`width:auto` + both max bounds —
   * CSS keeps the aspect ratio when both apply), never cropped or squashed.
   * Outlook desktop reads only the `width` attribute and ignores max-height,
   * so there it falls back to the width bound.
   */
  maxHeight?: number;
  radius?: number;
  align?: 'center';
}): string {
  const { src, alt, width, height, maxHeight, radius = 0 } = opts;
  const heightAttr = height ? ` height="${height}"` : '';
  // Only a FIXED box (thumbnail) may crop to fill it. A proportional image —
  // the logo — must never carry object-fit or a fixed height: either one can
  // crop a wide wordmark instead of scaling it down whole. A bounded box
  // (`maxHeight`) sizes it with max-width + max-height and `width:auto`, so
  // neither bound can distort it.
  const widthStyle =
    !height && maxHeight ? `width:auto;max-width:${width}px;` : `width:${width}px;max-width:100%;`;
  const heightStyle = height
    ? `height:${height}px;max-height:${height}px;object-fit:cover;`
    : maxHeight
      ? `height:auto;max-height:${maxHeight}px;`
      : 'height:auto;';
  const margin = opts.align === 'center' ? 'margin:0 auto;' : '';
  return (
    `<img src="${attr(src)}" alt="${attr(alt)}" width="${width}"${heightAttr} border="0" ` +
    `style="display:block;${margin}${widthStyle}${heightStyle}` +
    `border:0;outline:none;text-decoration:none;${radius ? `border-radius:${radius}px;` : ''}">`
  );
}

/** A small inline status pill — replaces the print page's giant watermark. */
export function emailBadge(label: string, tone: 'success' | 'warning' | 'danger'): string {
  const fg = EMAIL_COLORS[tone];
  const bg = EMAIL_COLORS[`${tone}Bg` as const];
  return (
    `<span style="display:inline-block;padding:3px 10px;border-radius:999px;` +
    `background-color:${bg};color:${fg};font-size:11px;line-height:16px;font-weight:700;` +
    `letter-spacing:0.04em;text-transform:uppercase;">${label}</span>`
  );
}

// ---------------------------------------------------------------------------
// Colour: brand tokens arrive as HSL components ("26 100% 50%") or hex.
// ---------------------------------------------------------------------------

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/**
 * Resolve a theme colour to a 6/3-digit hex, or `fallback`. Accepts `#hex`
 * and the Tailwind-token HSL component form. Anything else (including
 * injection attempts) is the fallback — the value lands in inline CSS.
 */
export function emailColor(
  value: string | null | undefined,
  fallback: string = BRAND.colors.gold
): string {
  if (!value || typeof value !== 'string' || value.length > 50) return fallback;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{3}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7);
  const m =
    /^([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)%\s+([0-9]+(?:\.[0-9]+)?)%(?:\s*\/\s*[0-9.]+%?)?$/.exec(
      v
    );
  if (m)
    return hslToHex(Number(m[1]) % 360, Math.min(100, Number(m[2])), Math.min(100, Number(m[3])));
  return fallback;
}

/** Mix a hex colour with white — a solid tint (no alpha, no color-mix()). */
export function emailTint(hex: string, amount: number): string {
  const full =
    hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex.slice(0, 7);
  const ch = (i: number) => parseInt(full.slice(i, i + 2), 16);
  const mix = (c: number) =>
    Math.round(c * amount + 255 * (1 - amount))
      .toString(16)
      .padStart(2, '0');
  return `#${mix(ch(1))}${mix(ch(3))}${mix(ch(5))}`;
}

// ---------------------------------------------------------------------------
// Inliner: content templates keep a tiny semantic vocabulary (h2/h3/p/ul,
// `.button`, `.order-table`, `.total-row`, `.address-box`) and this turns it
// into inline styles, so no template depends on the shell's <style>.
// ---------------------------------------------------------------------------

/** Prepend `style` to a start tag, keeping any inline style it already has
 *  (which comes LAST, so a template's explicit value still wins). */
function withStyle(tag: string, style: string): string {
  if (/\sstyle\s*=\s*"/i.test(tag)) {
    return tag.replace(/\sstyle\s*=\s*"/i, m => `${m}${style}`);
  }
  return tag.replace(/\s*(\/?)>$/, ` style="${style}"$1>`);
}

function styleTags(html: string, tagRe: RegExp, style: string): string {
  return html.replace(tagRe, tag => withStyle(tag, style));
}

export function inlineEmailStyles(html: string, opts: { dir: EmailDir; brand: string }): string {
  const { dir, brand } = opts;
  const { start, end } = emailSides(dir);
  const c = EMAIL_COLORS;
  // CSS custom properties are unparseable in Gmail — resolve the known tokens.
  const tokens: Record<string, string> = {
    brand,
    ink: c.ink,
    'ink-soft': c.inkSoft,
    'ink-mute': c.inkMute,
    line: c.line,
    'line-soft': c.lineSoft,
    bg: c.bg,
    'bg-soft': c.bgSoft,
  };
  let out = html.replace(/var\(--([a-z-]+)\)/g, (m, name: string) => tokens[name] ?? m);
  // Templates express alignment logically; Outlook only understands physical.
  out = out
    .replace(/text-align:\s*end\b/g, `text-align: ${end}`)
    .replace(/text-align:\s*start\b/g, `text-align: ${start}`);

  // Tables first (their cells get cell styles), then generic text tags.
  out = out.replace(
    /<table\b[^>]*class="[^"]*\border-table\b[^"]*"[^>]*>[\s\S]*?<\/table>/g,
    table => {
      let t = table.replace(/^<table\b[^>]*>/, open =>
        withStyle(
          open.replace(
            />$/,
            ' role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
          ),
          `width:100%;border-collapse:collapse;margin:18px 0;font-size:13px;`
        )
      );
      t = t.replace(/<tr\b[^>]*class="[^"]*\btotal-row\b[^"]*"[^>]*>[\s\S]*?<\/tr>/g, row =>
        styleTags(
          row,
          /<td\b[^>]*>/g,
          `font-weight:700;font-size:15px;border-top:2px solid ${c.line};border-bottom:0;padding-top:14px;`
        )
      );
      t = styleTags(
        t,
        /<th\b[^>]*>/g,
        `padding:10px 8px;text-align:${start};background-color:${c.bgSoft};color:${c.inkSoft};` +
          `font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;` +
          `border-bottom:1px solid ${c.lineSoft};`
      );
      t = styleTags(
        t,
        /<td\b[^>]*>/g,
        `padding:10px 8px;text-align:${start};color:${c.ink};border-bottom:1px solid ${c.lineSoft};vertical-align:middle;`
      );
      return t;
    }
  );

  out = styleTags(
    out,
    /<a\b[^>]*class="[^"]*\bbutton\b[^"]*"[^>]*>/g,
    `display:inline-block;background-color:${brand};color:#ffffff;padding:12px 22px;` +
      `text-decoration:none;border-radius:10px;font-weight:600;font-size:14px;line-height:20px;margin:8px 0;`
  );
  out = styleTags(
    out,
    /<div\b[^>]*class="[^"]*\baddress-box\b[^"]*"[^>]*>/g,
    `background-color:${c.bgSoft};padding:14px 16px;border-radius:12px;margin:14px 0;color:${c.inkSoft};`
  );
  out = styleTags(
    out,
    /<h1\b[^>]*>/g,
    `margin:0 0 14px;font-size:22px;line-height:1.3;color:${c.ink};`
  );
  out = styleTags(
    out,
    /<h2\b[^>]*>/g,
    `margin:0 0 14px;font-size:18px;line-height:1.3;color:${c.ink};`
  );
  out = styleTags(
    out,
    /<h3\b[^>]*>/g,
    `margin:22px 0 10px;font-size:16px;line-height:1.3;color:${c.ink};`
  );
  out = styleTags(out, /<p\b[^>]*>/g, `margin:0 0 14px;color:${c.inkSoft};`);
  out = styleTags(
    out,
    /<(?:ul|ol)\b[^>]*>/g,
    `margin:0 0 14px;padding-${start}:20px;color:${c.inkSoft};`
  );
  return out;
}
