'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PaletteItem } from './admin-layout/buildPaletteItems';
import { normalizeArabicSearch as normalize } from '@ebda/shared';
import { useT } from '@/i18n/useT';

/**
 * Global ⌘K / Ctrl+K command palette for the admin. Searches EVERY admin
 * destination — the sidebar hubs PLUS every page inside them (hub tabs) and the
 * Settings sub-pages — so a user can jump anywhere from anywhere. The item list
 * is built (role/feature-gated) by {@link buildStorePaletteItems} in AdminLayout.
 *
 * Dependency-free (no `cmdk`) to avoid adding a package + the CF npm@10.9.2
 * lockfile regeneration step. Opens via ⌘K/Ctrl+K OR a `force:open-search`
 * window event (dispatched by the sidebar search button for mouse/touch users).
 *
 * Search is bilingual: `normalize()` lowercases, strips Arabic diacritics
 * (tashkeel) and folds alef / ya / ta-marbuta variants so an Arabic query
 * matches regardless of how the label was typed. The hub/section name is part
 * of the haystack, so typing "stock" finds every Inventory page even when the
 * page's own name doesn't contain the word.
 */

export function CommandPalette({ items }: { items: PaletteItem[] }) {
  const router = useRouter();
  const t = useT('components.commandPalette');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

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
    const q = normalize(query);
    if (!q) return items;
    const terms = q.split(/\s+/).filter(Boolean);
    // Every whitespace-separated term must appear somewhere in name + section +
    // keywords, so "stock supplier" narrows like a human expects AND a concept
    // word ("logo" / "شعار") finds the page that contains it (e.g. Branding).
    return items.filter(i => {
      const hay = normalize(`${i.group ?? ''} ${i.name} ${i.keywords ?? ''}`);
      return terms.every(term => hay.includes(term));
    });
  }, [query, items]);

  useEffect(() => setActive(0), [query]);

  // Keep the active row in view as the user arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

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
            className="h-12 w-full bg-transparent text-sm text-foreground outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground"
            aria-label={t('placeholder')}
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </div>
        <ul ref={listRef} className="max-h-[60vh] overflow-y-auto p-2">
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">{t('empty')}</li>
          ) : (
            results.map((item, idx) => (
              <li key={item.href} data-idx={idx}>
                <button
                  type="button"
                  onClick={() => go(item.href)}
                  onMouseEnter={() => setActive(idx)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start text-sm transition-colors ${
                    idx === active
                      ? 'bg-primary/10 text-primary-ink'
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
                        d={item.icon ?? 'M9 5l7 7-7 7'}
                      />
                    </svg>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{item.name}</span>
                    {item.group && item.group !== item.name && (
                      <span className="truncate text-xs text-muted-foreground">{item.group}</span>
                    )}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
          <span>{t('countResults', { count: results.length })}</span>
          <span className="hidden sm:inline">{t('navHint')}</span>
        </div>
      </div>
    </div>
  );
}
