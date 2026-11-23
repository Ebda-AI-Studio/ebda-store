'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import type { PaletteItem } from './admin-layout/buildPaletteItems';
import {
  normalizeArabicSearch as normalize,
  searchQueryHeaders,
  type AdminSearchResponse,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiGet } from '../lib/api';
import { formatPrice } from '../lib/format';

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

/** Debounce before a record lookup (products / orders / customers) is sent. */
const RECORD_DEBOUNCE_MS = 150;
const RECORD_MIN_CHARS = 1;
/** Cap on page + setting rows so a one-letter query does not render the whole registry. */
const MAX_PAGE_RESULTS = 40;

/** One selectable row: a page (from `items`) or a record found by the server. */
interface Row {
  key: string;
  href: string;
  title: string;
  sub?: string;
  icon?: string;
  /** Header shown above the first row of a record group. */
  section?: 'products' | 'orders' | 'customers';
}

const RECORD_ICON = {
  products: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  orders:
    'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
  customers: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
};

export function CommandPalette({ items }: { items: PaletteItem[] }) {
  const router = useRouter();
  const locale = useLocale();
  const params = useParams<{ id?: string }>();
  // The palette mounts inside store routes; with no store in the URL there is nothing to look up.
  const storeId = typeof params?.id === 'string' ? params.id : null;
  const t = useT('components.commandPalette');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [records, setRecords] = useState<AdminSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState<'rate' | 'error' | null>(null);
  const requestSeq = useRef(0);
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
    setRecords(null);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const results = useMemo(() => {
    const q = normalize(query);
    // An empty palette is the short list of hubs and pages; single settings appear once you type.
    if (!q) return items.filter(i => i.kind !== 'setting');
    const terms = q.split(/\s+/).filter(Boolean);
    // Every whitespace-separated term must appear somewhere in name + section +
    // keywords, so "stock supplier" narrows like a human expects AND a concept
    // word ("logo" / "شعار") finds the page that contains it (e.g. Branding).
    // Best first: the name holds every term, then name + section, then keywords/synonyms only;
    // pages before the single settings on them; the original order breaks ties.
    const ranked: Array<{ item: PaletteItem; rank: number; idx: number }> = [];
    items.forEach((item, idx) => {
      const hay = normalize(`${item.group ?? ''} ${item.name} ${item.keywords ?? ''}`);
      if (!terms.every(term => hay.includes(term))) return;
      const name = normalize(item.name);
      const named = normalize(`${item.group ?? ''} ${item.name}`);
      const rank = terms.every(term => name.includes(term))
        ? 0
        : terms.every(term => named.includes(term))
          ? 1
          : 2;
      ranked.push({ item, rank, idx });
    });
    return ranked
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          Number(a.item.kind === 'setting') - Number(b.item.kind === 'setting') ||
          a.idx - b.idx
      )
      .slice(0, MAX_PAGE_RESULTS)
      .map(r => r.item);
  }, [query, items]);

  useEffect(() => setActive(0), [query]);

  // Record lookup: products, orders and customers of THIS store, debounced. A reply for an older
  // query is dropped (the counter) and its request aborted.
  useEffect(() => {
    const q = query.trim();
    setRecords(null);
    setFailure(null);
    if (!open || !storeId || q.length < RECORD_MIN_CHARS) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // The term rides in a header, never the URL (Ruling SEARCH-P2-9): it is often a phone or email.
      apiGet<AdminSearchResponse>(
        `/api/v1/stores/${storeId}/search`,
        searchQueryHeaders(q),
        controller.signal
      )
        .then(({ data, error }) => {
          if (seq !== requestSeq.current) return;
          setRecords(data ?? null);
          // 429 = the per-user limit; anything else is a failed lookup. Neither is "no results".
          setFailure(
            error
              ? error.status === 429 || error.code === 'RATE_LIMITED'
                ? 'rate'
                : 'error'
              : null
          );
        })
        .catch(() => {
          if (seq === requestSeq.current) {
            setRecords(null);
            setFailure('error');
          }
        })
        .finally(() => {
          if (seq === requestSeq.current) setSearching(false);
        });
    }, RECORD_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open, storeId]);

  const failureText = failure ? t(failure === 'rate' ? 'rateLimited' : 'searchFailed') : null;

  const rows = useMemo<Row[]>(() => {
    const pages: Row[] = results.map(i => ({
      key: i.href,
      href: i.href,
      title: i.name,
      sub: i.group && i.group !== i.name ? i.group : undefined,
      icon: i.icon,
    }));
    if (!records || !storeId) return pages;
    const out: Row[] = [...pages];
    const push = (section: NonNullable<Row['section']>, list: Row[]) =>
      list.forEach((r, i) =>
        out.push({ ...r, icon: RECORD_ICON[section], section: i === 0 ? section : undefined })
      );
    push(
      'products',
      records.products.map(p => ({
        key: `p:${p.id}`,
        href: `/stores/${storeId}/products/${p.id}/edit`,
        title: (locale === 'ar' && p.nameAr) || p.name,
        sub: p.sku ?? undefined,
      }))
    );
    push(
      'orders',
      records.orders.map(o => ({
        key: `o:${o.id}`,
        href: `/stores/${storeId}/orders/${o.id}`,
        title: `#${o.orderNumber}`,
        sub: [o.customerName, formatPrice(o.total)].filter(Boolean).join(' · '),
      }))
    );
    push(
      'customers',
      records.customers.map(c => ({
        key: `c:${c.key}`,
        href: `/stores/${storeId}/customers/${encodeURIComponent(c.key)}`,
        title: c.name || c.phone || c.key,
        sub:
          [c.phone && c.name ? c.phone : '', c.isGuest ? t('guest') : '']
            .filter(Boolean)
            .join(' · ') || undefined,
      }))
    );
    return out;
  }, [results, records, storeId, locale, t]);

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
      setActive(a => Math.min(a + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(a => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[active];
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
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            {/* i18n-gate-allow: keyboard keycap */}
            ESC
          </kbd>
        </div>
        <ul ref={listRef} className="max-h-[60vh] overflow-y-auto p-2">
          {rows.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              {searching ? t('searching') : (failureText ?? t('empty'))}
            </li>
          ) : (
            rows.map((item, idx) => (
              <li key={item.key} data-idx={idx}>
                {item.section && (
                  <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(item.section)}
                  </p>
                )}
                <button
                  data-ui="row"
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
                    <span className="truncate font-medium">{item.title}</span>
                    {item.sub && (
                      <span className="truncate text-xs text-muted-foreground">{item.sub}</span>
                    )}
                  </span>
                </button>
              </li>
            ))
          )}
          {rows.length > 0 && failureText && (
            <li role="alert" className="px-3 py-2 text-center text-xs text-destructive-ink">
              {failureText}
            </li>
          )}
          {rows.length > 0 && searching && (
            <li className="px-3 py-2 text-center text-xs text-muted-foreground">
              {t('searching')}
            </li>
          )}
        </ul>
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>{t('countResults', { count: rows.length })}</span>
          <span className="hidden sm:inline">{t('navHint')}</span>
        </div>
      </div>
    </div>
  );
}
