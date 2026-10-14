/**
 * Standalone typography zone CSS emitter — extracted 2026-05-20 to support
 * "Preview unsaved" drafts. The root layout.tsx has its OWN inline copy of
 * this logic that runs at SSR for the committed store typography. When the
 * page-builder admin sends a draft bundle (`?_layoutDraft=<token>`), the
 * storefront page.tsx fetches the draft typography + theme and emits an
 * ADDITIONAL <style> tag using THIS util in body — source-order priority
 * means the draft rules win over the committed ones from <head>.
 *
 * Keep this in lockstep with layout.tsx's inline emitter. If you change one,
 * change the other. Yes that's a small duplication tax; refactoring
 * layout.tsx's full emitter out is a separate cleanup.
 */

import type { StoreTheme } from '@ebda/shared';

const ZONE_NAMES = [
  'beforeHeader',
  'header',
  'storeName',
  'mobile-search',
  'categories',
  'categoryLabel',
  'products',
  'footer',
  'afterFooter',
  'cookieFallback',
  'sectionKicker',
  'sectionTitle',
  'sectionSubtitle',
  'sectionSeeAll',
  'productName',
  'productPrice',
  'productCta',
  'cta',
  'filters',
] as const;

function sanitizeFontValue(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200) return null;
  if (/[{}]|url\s*\(|@import|expression\s*\(|javascript\s*:|<|>/i.test(v)) return null;
  return v;
}

function sanitizeUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 2048) return null;
  if (!/^https:\/\//.test(v)) return null;
  if (/["'<>{}\\]/.test(v)) return null;
  return v;
}

type ColorFieldContext = 'text' | 'background';

function resolveColorValue(
  v: string,
  _context: ColorFieldContext = 'background',
  _theme?: StoreTheme
): string {
  if (v.startsWith('token:')) {
    const key = v.slice('token:'.length);
    if (/^[a-zA-Z][a-zA-Z0-9-]{0,32}$/.test(key)) {
      return `hsl(var(--${key}))`;
    }
    return 'inherit';
  }
  if (v === 'brand-primary') return 'hsl(var(--primary, 220 13% 18%))';
  if (v === 'brand-secondary') return 'hsl(var(--secondary, 220 14% 96%))';
  if (v === 'brand-accent') return 'hsl(var(--accent, 220 14% 92%))';
  return v;
}

export interface ZoneEmitInput {
  fonts?: Array<{
    type?: 'google' | 'custom';
    url?: string;
    family?: string;
    format?: string;
    weight?: string;
    style?: string;
  }>;
  zones?: Record<string, Record<string, string> | undefined>;
}

/** Builds a CSS string from a typography settings object. Returns an empty
 *  string when nothing is configured. */
export function emitZoneCss(typo: ZoneEmitInput | null | undefined, theme?: StoreTheme): string {
  if (!typo) return '';
  const fontFaceRules: string[] = [];
  const fontLinks: string[] = []; // Google Font URLs — caller decides how to load.
  if (typo.fonts && Array.isArray(typo.fonts)) {
    for (const f of typo.fonts) {
      const url = sanitizeUrl(f.url);
      if (!url) continue;
      if (f.type === 'google') {
        fontLinks.push(url);
      } else if (f.type === 'custom') {
        const family = sanitizeFontValue(f.family);
        const format = ['woff2', 'woff', 'ttf', 'otf'].includes(String(f.format))
          ? String(f.format)
          : 'woff2';
        if (!family) continue;
        const weight = sanitizeFontValue(f.weight) ?? 'normal';
        const style = f.style === 'italic' ? 'italic' : 'normal';
        fontFaceRules.push(
          `@font-face{font-family:'${family}';src:url('${url}') format('${format}');font-weight:${weight};font-style:${style};font-display:swap;}`
        );
      }
    }
  }
  const zoneRules: string[] = [];
  if (typo.zones) {
    for (const zone of ZONE_NAMES) {
      const cfg = typo.zones[zone];
      if (!cfg || typeof cfg !== 'object') continue;
      const decls: string[] = [];
      const fam = sanitizeFontValue(cfg.fontFamily);
      if (fam) decls.push(`font-family:${fam} !important`);
      const size = sanitizeFontValue(cfg.fontSize);
      if (size) decls.push(`font-size:${size}`);
      const weight = sanitizeFontValue(cfg.fontWeight);
      if (weight) decls.push(`font-weight:${weight}`);
      const lh = sanitizeFontValue(cfg.lineHeight);
      if (lh) {
        decls.push(`line-height:${lh}`);
      } else if (size) {
        decls.push('line-height:1.6');
      }
      const ls = sanitizeFontValue(cfg.letterSpacing);
      if (ls) decls.push(`letter-spacing:${ls}`);
      const color = sanitizeFontValue(cfg.color);
      if (color) decls.push(`color:${resolveColorValue(color, 'text', theme)}`);
      const bg = sanitizeFontValue(cfg.backgroundColor);
      const padding = sanitizeFontValue(cfg.padding);
      const radius = sanitizeFontValue(cfg.borderRadius);
      if (bg) decls.push(`background-color:${resolveColorValue(bg, 'background', theme)}`);
      if (padding) decls.push(`padding:${padding}`);
      if (radius) decls.push(`border-radius:${radius}`);
      if ((bg || padding || radius) && !cfg.display) {
        decls.push('display:inline-block');
      }
      const td = sanitizeFontValue(cfg.textDecoration);
      if (td) decls.push(`text-decoration:${td}`);
      const tdc = sanitizeFontValue(cfg.textDecorationColor);
      if (tdc) decls.push(`text-decoration-color:${resolveColorValue(tdc, 'text', theme)}`);
      const tdt = sanitizeFontValue(cfg.textDecorationThickness);
      if (tdt) decls.push(`text-decoration-thickness:${tdt}`);
      const tuo = sanitizeFontValue(cfg.textUnderlineOffset);
      if (tuo) decls.push(`text-underline-offset:${tuo}`);
      const tt = sanitizeFontValue(cfg.textTransform);
      if (tt) decls.push(`text-transform:${tt}`);
      if (decls.length === 0) continue;
      zoneRules.push(`[data-zone="${zone}"], [data-zone="${zone}"] *{${decls.join(';')}}`);
    }
  }
  const linkTags = fontLinks.map(url => `@import url('${url}');`);
  return [...linkTags, ...fontFaceRules, ...zoneRules].join('\n');
}
