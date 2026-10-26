'use client';

import { useEffect } from 'react';

/**
 * Keyboard and pointer behaviour for the header's two <details> menus (the Products panel and the mobile menu). The
 * markup works without JavaScript (a plain <details> disclosure); this only adds what a disclosure lacks:
 *   - Esc closes the open menu and returns focus to its trigger;
 *   - a click or tap outside closes it, and so does moving focus out of it (Tab away);
 *   - opening one menu closes the other;
 *   - choosing a link inside closes it (a client-side navigation keeps the page, so the panel would stay open);
 *   - the trigger carries aria-expanded, kept in step with the open state.
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

    for (const d of menus()) sync(d);
    header.addEventListener('toggle', onToggle, true);
    header.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    return () => {
      header.removeEventListener('toggle', onToggle, true);
      header.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
    };
  }, []);
  return null;
}
