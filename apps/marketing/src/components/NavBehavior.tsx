'use client';

import { useEffect } from 'react';

/**
 * Keyboard and pointer behaviour for the header's two <details> menus (the Products panel and the mobile menu). The
 * markup works without JavaScript (a plain <details> disclosure); this only adds what a disclosure lacks:
 *   - Esc closes the open menu and returns focus to its trigger;
 *   - a click or tap outside closes it, and so does moving focus out of it (Tab away);
 *   - opening one menu closes the other;
 *   - choosing a link inside closes it (a client-side navigation keeps the page, so the panel would stay open);
 *   - the trigger carries aria-expanded, kept in step with the open state;
 *   - `--sticky-h` on <html> is the header's real rendered height (studio bar plus the product bar when there is one),
 *     kept current by a ResizeObserver. globals.css has the no-JS fallback; story pinning, the legal TOC and every
 *     `[id]` scroll-margin read it, so nothing starts under the sticky chrome at any width or breakpoint.
 *   - a #hash target (deep link or in-page link) is held directly under the sticky chrome while layout above it settles.
 * It renders nothing.
 */
export function NavBehavior() {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>('.site-header');
    if (!header) return;
    const menus = () => Array.from(header.querySelectorAll<HTMLDetailsElement>('details'));
    const trigger = (d: HTMLDetailsElement) => d.querySelector<HTMLElement>(':scope > summary');
    const sync = (d: HTMLDetailsElement) =>
      trigger(d)?.setAttribute('aria-expanded', String(d.open));
    const closeAll = (except?: HTMLDetailsElement) => {
      for (const d of menus()) if (d !== except && d.open) d.open = false;
    };

    const onToggle = (e: Event) => {
      const d = e.target as HTMLDetailsElement;
      if (d.tagName !== 'DETAILS') return;
      sync(d);
      if (d.open) closeAll(d);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const open = menus().find(d => d.open);
      if (!open) return;
      open.open = false;
      trigger(open)?.focus();
    };
    /** Pointer or focus landed outside an open menu: close it. */
    const onOutside = (e: Event) => {
      const t = e.target as Node;
      for (const d of menus()) if (d.open && !d.contains(t)) d.open = false;
    };
    const onClick = (e: MouseEvent) => {
      // a new-tab or modified click leaves this page where it is, so the menu stays
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as HTMLElement).closest('a');
      const d = a?.closest('details');
      if (a && d && header.contains(d)) d.open = false;
    };

    const root = document.documentElement;
    const measure = () => root.style.setProperty('--sticky-h', `${header.offsetHeight}px`);
    measure();

    // Anchor landing. The browser scrolls to a #hash once, with whatever layout exists at that moment; lazy media,
    // hydration and font swaps above the target then move it (measured: 13px to 350px off). So a hash target stays
    // "pinned" for a few seconds: whenever the page's size changes it is put back directly under the sticky chrome,
    // until the person scrolls, types or touches (their own scroll always wins).
    let pin: string | null = null;
    let pinTimer: number | undefined;
    let pinTick: number | undefined;
    const realign = () => {
      const el = pin ? document.getElementById(pin) : null;
      if (!el) return;
      const d = el.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
      if (Math.abs(d) > 1) window.scrollBy({ top: d, behavior: 'instant' });
    };
    const stopPin = () => {
      pin = null;
      window.clearTimeout(pinTimer);
      window.clearInterval(pinTick);
    };
    const startPin = (hash: string) => {
      if (hash.length < 2) return;
      try {
        pin = decodeURIComponent(hash.slice(1));
      } catch {
        return;
      }
      window.clearTimeout(pinTimer);
      window.clearInterval(pinTick);
      pinTimer = window.setTimeout(stopPin, 6000);
      // size changes above the target are caught by the observer; a poll covers shifts that net to no size change
      pinTick = window.setInterval(realign, 200);
      window.setTimeout(realign, 50);
    };
    const onHashClick = (e: MouseEvent) => {
      // (no defaultPrevented check: next/link prevents the default and routes client-side, which is the case to hold)
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as HTMLElement).closest('a');
      if (
        !a ||
        !a.hash ||
        a.pathname.replace(/\/?$/, '/') !== location.pathname.replace(/\/?$/, '/')
      )
        return;
      startPin(a.hash);
    };
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            measure();
            realign();
          });
    ro?.observe(header);
    ro?.observe(document.body);
    document.fonts?.ready.then(measure).catch(() => {});
    startPin(location.hash);
    const onHash = () => startPin(location.hash);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    window.addEventListener('wheel', stopPin, { passive: true });
    window.addEventListener('touchstart', stopPin, { passive: true });
    window.addEventListener('keydown', stopPin);
    document.addEventListener('click', onHashClick);

    for (const d of menus()) sync(d);
    header.addEventListener('toggle', onToggle, true);
    header.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    return () => {
      ro?.disconnect();
      stopPin();
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
      window.removeEventListener('wheel', stopPin);
      window.removeEventListener('touchstart', stopPin);
      window.removeEventListener('keydown', stopPin);
      document.removeEventListener('click', onHashClick);
      root.style.removeProperty('--sticky-h');
      header.removeEventListener('toggle', onToggle, true);
      header.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
    };
  }, []);
  return null;
}
