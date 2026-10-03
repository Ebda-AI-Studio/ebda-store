'use client';

/**
 * Typography probe.
 *
 * Renders nothing visible. Activates only when the URL carries
 * `?probe=typography` AND the page is loaded inside an iframe whose
 * parent origin matches a trusted admin host. On activation, after the
 * page has hydrated and the data-zone wrappers are in the DOM, it
 * measures `getComputedStyle()` for the first element of each known
 * zone and `postMessage`s the values back to the parent. The admin
 * typography page reads these messages to display real, measured
 * inherited defaults next to each zone field — replacing the
 * approximations we used to invent.
 *
 * Security: we only respond to a postMessage handshake from
 * `window.parent` (i.e. running inside an iframe), and we restrict
 * the response targetOrigin to the parent's origin reported via
 * `window.location.ancestorOrigins[0]`. If that's missing or doesn't
 * look like one of our admin hosts, we no-op.
 */

import { useEffect } from 'react';
import { BRAND } from '@force/shared';

const ZONES = [
  'beforeHeader',
  'header',
  'categories',
  'products',
  'footer',
  'afterFooter',
  'sectionTitle',
  'productName',
  'productPrice',
  'cta',
  'filters',
] as const;

const TRUSTED_ADMIN_HOSTS = [BRAND.domains.app, 'localhost', '127.0.0.1'];

function isTrustedParentOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return TRUSTED_ADMIN_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

export function TypographyProbe() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('probe') !== 'typography') return;
    // Must be in an iframe to have a parent to postMessage to.
    if (window.parent === window) return;

    const parentOrigin = window.location.ancestorOrigins?.[0];
    // Firefox doesn't support ancestorOrigins, but admin runs on
    // Chrome / Edge — leave Firefox unsupported rather than allowing
    // unverified parents.
    if (!parentOrigin || !isTrustedParentOrigin(parentOrigin)) return;

    // Wait one paint after hydration so per-store typography styles
    // (injected from app/layout.tsx via the typography blob) have
    // actually applied. Without this, we'd measure unstyled defaults.
    const measure = () => {
      const measurements: Record<string, Record<string, string>> = {};
      for (const zone of ZONES) {
        const el = document.querySelector(`[data-zone="${zone}"]`);
        if (!el) continue;
        const cs = window.getComputedStyle(el);
        measurements[zone] = {
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          letterSpacing: cs.letterSpacing,
          color: cs.color,
        };
      }
      window.parent.postMessage({ type: 'force:typography-probe', measurements }, parentOrigin);
    };

    // Two rAFs after mount so Next.js paint + browser layout are done.
    const id = window.requestAnimationFrame(() => window.requestAnimationFrame(measure));
    return () => window.cancelAnimationFrame(id);
  }, []);

  return null;
}
