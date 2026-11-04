'use client';

import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from 'react';
import Link from './StoreLink';
import Image from 'next/image';
import { highlightSegments, useListboxNav, useLiveSearch } from '@ebda/ui';
import { useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useLocalePrice } from '../hooks/useLocalePrice';
import { api, type SearchSuggestion } from '../lib/api';
import { countText, RESULTS } from '../lib/plural';
import { MissingImage } from '../templates/shared/MissingImage';

// ─── Props ────────────────────────────────────────────────────────────────────

interface SearchAutocompleteProps {
  /** Live query string from the parent input. Component owns nothing else. */
  query: string;
  /** Called when the user picks a suggestion (so the parent can close the
   *  expanded search row, clear focus, etc.). Optional. */
  onSelect?: () => void;
  /** The committed query the page already shows results for (kept in history state, not the URL:
   *  Ruling SEARCH-URL-1). The dropdown stays closed for that untouched term, also when it
   *  changes client-side without a remount (the header search from one term to another).
   *  Defaults to `query` at mount. */
  committedQuery?: string;
}

/** Suggestions for one term. Throws on an API failure so the box shows the error state, not "no results". */
async function fetchSuggestions(q: string, signal: AbortSignal): Promise<SearchSuggestion[]> {
  const res = await api.searchSuggest(q, signal);
  if (!res.success || !res.data) throw new Error('suggest failed');
  return res.data.suggestions ?? [];
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Header search-as-you-type. The parent owns the <input>; this component finds it (the input in the
 * same wrapper or form), turns it into an ARIA combobox (role, aria-expanded, aria-controls,
 * aria-activedescendant) and handles Arrow / Home / End / Enter / Escape on it, so no template has
 * to forward keys. Results come from the first character (one Arabic letter is a word), after 150 ms,
 * and a slower older response can never replace a newer one (useLiveSearch aborts + ignores it).
 */
export function SearchAutocomplete({ query, onSelect, committedQuery }: SearchAutocompleteProps) {
  const storeUrl = useStoreUrl();
  const { language, t } = useLanguage();
  const money = useLocalePrice();
  const isAr = language === 'ar';

  const anchorRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();

  // The query the parent mounted us with (a restored search prefills the input). Suggestions for that
  // untouched term would open a dropdown over the first row of the results the page already
  // shows, so we stay closed until the visitor edits the field (PR 1 visual gate).
  const mountedQueryRef = useRef((committedQuery ?? query).trim());
  const [edited, setEdited] = useState(false);
  // The term the visitor dismissed with Escape / a pick / an outside click: closed until it changes.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  // A new committed query (URL changed while we stayed mounted) is a fresh prefill: forget the
  // edit and close, so the new results are not covered either.
  useEffect(() => {
    if (committedQuery === undefined) return;
    const next = committedQuery.trim();
    if (next === mountedQueryRef.current) return;
    mountedQueryRef.current = next;
    setEdited(false);
    setDismissedFor(null);
  }, [committedQuery]);

  useEffect(() => {
    if (trimmed !== mountedQueryRef.current) setEdited(true);
  }, [trimmed]);

  const editedNow = edited || trimmed !== mountedQueryRef.current;
  const { status, results, settledQuery } = useLiveSearch<SearchSuggestion>({
    query,
    search: fetchSuggestions,
    enabled: editedNow,
  });

  const open = editedNow && trimmed.length >= 1 && dismissedFor !== trimmed;
  const setOpen = useCallback((next: boolean) => setDismissedFor(next ? null : trimmed), [trimmed]);

  const pick = useCallback(
    (index: number) => {
      const item = results[index];
      if (!item) return;
      setOpen(false);
      onSelect?.();
      window.location.href = storeUrl(`/products/${item.slug}`);
    },
    [results, setOpen, onSelect, storeUrl]
  );

  const nav = useListboxNav({ count: results.length, open, setOpen, onPick: pick });
  // Reset the highlighted option whenever the result set changes.
  const { setActiveIndex } = nav;
  useEffect(() => setActiveIndex(-1), [settledQuery, setActiveIndex]);

  // ── Make the parent's input a combobox ────────────────────────────────────
  const navRef = useRef(nav);
  navRef.current = nav;
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  useEffect(() => {
    const host = anchorRef.current?.parentElement;
    setInput(
      (host?.querySelector('input') as HTMLInputElement | null) ??
        (anchorRef.current?.closest('form')?.querySelector('input') as HTMLInputElement | null) ??
        null
    );
  }, [editedNow]);
  useEffect(() => {
    if (!input) return;
    const onKey = (ev: globalThis.KeyboardEvent) =>
      navRef.current.inputProps.onKeyDown(ev as unknown as KeyboardEvent<HTMLElement>);
    input.addEventListener('keydown', onKey);
    return () => input.removeEventListener('keydown', onKey);
  }, [input]);
  useEffect(() => {
    if (!input) return;
    const { inputProps } = nav;
    input.setAttribute('role', inputProps.role);
    input.setAttribute('aria-autocomplete', inputProps['aria-autocomplete']);
    input.setAttribute('aria-haspopup', inputProps['aria-haspopup']);
    input.setAttribute('aria-controls', inputProps['aria-controls']);
    input.setAttribute('aria-expanded', String(open && status !== 'idle'));
    if (inputProps['aria-activedescendant'])
      input.setAttribute('aria-activedescendant', inputProps['aria-activedescendant']);
    else input.removeAttribute('aria-activedescendant');
    input.setAttribute('autocomplete', 'off');
  });

  // ── Click outside to close ─────────────────────────────────────────────────
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || input?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [input, setOpen]);

  const loading = status === 'loading';
  const showPopup = open && status !== 'idle';
  const announce =
    status === 'ready'
      ? results.length === 0
        ? t('No products found', 'مفيش منتجات')
        : countText(language, results.length, RESULTS, String(results.length))
      : status === 'loading'
        ? t('Searching...', 'بندوّر...')
        : status === 'error'
          ? t('Search is unavailable right now', 'البحث مش شغال دلوقتي')
          : '';

  // Nothing is rendered until the visitor edits the field: the header markup stays byte-identical.
  if (!editedNow) return null;

  return (
    <>
      <span ref={anchorRef} hidden />
      <div role="status" aria-live="polite" className="sr-only">
        {open ? announce : ''}
      </div>
      {showPopup && (
        <div
          ref={containerRef}
          className="absolute top-full left-0 right-0 z-50 mt-1 max-h-[70vh] overflow-y-auto overscroll-contain rounded-xl border border-border bg-background shadow-xl"
        >
          {/* Loading / empty / error rows sit outside the listbox so it only ever holds options. */}
          {loading && (
            <div className="flex items-center justify-center gap-2 px-4 py-3 text-sm text-muted-foreground">
              <svg
                className="h-4 w-4 motion-safe:animate-spin"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              {t('Searching...', 'بندوّر...')}
            </div>
          )}
          {status === 'ready' && results.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              {t('No products found', 'مفيش منتجات')}
            </div>
          )}
          {status === 'error' && (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              {t('Search is unavailable right now. Try again.', 'البحث مش شغال دلوقتي. جرّب تاني.')}
            </div>
          )}
          <div
            {...nav.listProps}
            aria-label={t('Search suggestions', 'اقتراحات البحث')}
            aria-busy={loading}
            hidden={status !== 'ready' || results.length === 0}
          >
            {results.map((product, idx) => {
              const isActive = nav.activeIndex === idx;
              const displayName = isAr && product.nameAr ? product.nameAr : product.name;
              const priceMajor = money(product.price);

              return (
                <Link
                  key={product.id}
                  id={nav.optionId(idx)}
                  href={storeUrl(`/products/${product.slug}`)}
                  role="option"
                  aria-selected={isActive}
                  tabIndex={-1}
                  className={`flex min-h-[44px] items-center gap-3 px-4 py-2.5 text-sm text-start transition-colors hover:bg-muted ${
                    isActive ? 'bg-muted' : ''
                  }`}
                  onMouseDown={e => e.preventDefault() /* keep focus in the input */}
                  onClick={() => {
                    setOpen(false);
                    onSelect?.();
                  }}
                >
                  {/* Thumbnail */}
                  <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
                    {product.image ? (
                      <Image
                        src={product.image}
                        alt=""
                        width={48}
                        height={48}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="relative h-full w-full">
                        <MissingImage label={displayName} size="sm" />
                      </div>
                    )}
                  </div>

                  {/* Name + price */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">
                      {highlightSegments(displayName, settledQuery).map((seg, i) =>
                        seg.match ? (
                          <mark key={i} className="rounded-sm bg-primary/15 text-inherit">
                            {seg.text}
                          </mark>
                        ) : (
                          <span key={i}>{seg.text}</span>
                        )
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">{priceMajor}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
