'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { NavItem } from './admin-layout/buildStoreAdminNav';
import { useT } from '@/i18n/useT';

/**
 * Global ⌘K / Ctrl+K command palette for the admin. Searches every admin
 * destination (the same role-aware {@link NavItem}[] the sidebar renders) so a
 * user can jump to any page from anywhere — no clicking through the sidebar.
 *
 * Dependency-free (no `cmdk`) to avoid adding a package + the CF npm@10.9.2
 * lockfile regeneration step. Opens via ⌘K/Ctrl+K OR a `force:open-search`
 * window event (dispatched by the sidebar search button for mouse/touch users).
 */
export function CommandPalette({ navItems }: { navItems: NavItem[] }) {
  const router = useRouter();
  const t = useT('components.commandPalette');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Open via ⌘K / Ctrl+K (toggle) or a custom event from the sidebar button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('force:open-search', onOpen as EventListener);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('force:open-search', onOpen as EventListener);
    };
  }, []);

  // Reset + focus on open.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return navItems;
    return navItems.filter(i => i.name.toLowerCase().includes(q));
  }, [query, navItems]);

  useEffect(() => setActive(0), [query]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(a => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(a => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[active];
      if (r) go(r.href);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        onClick={e => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          <svg
            className="h-4 w-4 shrink-0 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
            />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('placeholder')}
            className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            aria-label={t('placeholder')}
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </div>
        <ul className="max-h-[60vh] overflow-y-auto p-2">
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">{t('empty')}</li>
          ) : (
            results.map((item, idx) => (
              <li key={item.href}>
                <button
                  type="button"
                  onClick={() => go(item.href)}
                  onMouseEnter={() => setActive(idx)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start text-sm transition-colors ${
                    idx === active
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-muted/70'
                  }`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d={item.icon}
                      />
                    </svg>
                  </span>
                  <span className="font-medium">{item.name}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
