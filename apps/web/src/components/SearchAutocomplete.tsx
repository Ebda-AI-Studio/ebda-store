'use client';

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useNumerals } from '../hooks/useNumerals';
import { api, type SearchSuggestion } from '../lib/api';

// ─── Props ────────────────────────────────────────────────────────────────────

interface SearchAutocompleteProps {
  /** Live query string from the parent input. Component owns nothing else. */
  query: string;
  /** Called when the user picks a suggestion (so the parent can close the
   *  expanded search row, clear focus, etc.). Optional. */
  onSelect?: () => void;
}

// ─── Module-level cache ──────────────────────────────────────────────────────
//
// Cache suggestion results per query string for the lifetime of the page
// session so revisiting the same query doesn't trigger another round-trip.
// Keyed by lowercased trimmed query; bounded to 50 entries so a long
// session can't grow this without limit.
const SUGGEST_CACHE = new Map<string, SearchSuggestion[]>();
const SUGGEST_CACHE_LIMIT = 50;

function cacheGet(key: string): SearchSuggestion[] | undefined {
  return SUGGEST_CACHE.get(key);
}

function cacheSet(key: string, value: SearchSuggestion[]) {
  if (SUGGEST_CACHE.size >= SUGGEST_CACHE_LIMIT) {
    // Simple FIFO eviction — Map iteration order is insertion order
    const firstKey = SUGGEST_CACHE.keys().next().value;
    if (firstKey !== undefined) SUGGEST_CACHE.delete(firstKey);
  }
  SUGGEST_CACHE.set(key, value);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SearchAutocomplete({ query, onSelect }: SearchAutocompleteProps) {
  const storeUrl = useStoreUrl();
  const { language, t } = useLanguage();
  const { money } = useNumerals();
  const isAr = language === 'ar';

  const [suggestions, setSuggestions] = useState<SearchSuggestion[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the latest query the user typed so a slow earlier response
  // can't overwrite a faster later one. Same-stale-request guard pattern.
  const latestQueryRef = useRef('');

  // ── Fetch suggestions ──────────────────────────────────────────────────────

  const fetchSuggestions = useCallback(async (q: string) => {
    const key = q.toLowerCase();

    // Cache hit — render immediately, no network call.
    const cached = cacheGet(key);
    if (cached) {
      if (latestQueryRef.current === q) {
        setSuggestions(cached);
        setIsOpen(true);
        setActiveIndex(-1);
      }
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.searchSuggest(q);
      // If the user typed something else while we were waiting, drop
      // this response on the floor.
      if (latestQueryRef.current !== q) return;

      if (res.success && res.data) {
        const list = res.data.suggestions ?? [];
        cacheSet(key, list);
        setSuggestions(list);
        setIsOpen(true);
        setActiveIndex(-1);
      } else {
        setSuggestions([]);
        setIsOpen(true);
      }
    } catch {
      if (latestQueryRef.current === q) {
        setSuggestions([]);
        setIsOpen(true);
      }
    } finally {
      if (latestQueryRef.current === q) setIsLoading(false);
    }
  }, []);

  // ── Debounced query → fetch ────────────────────────────────────────────────

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();
    latestQueryRef.current = trimmed;

    if (trimmed.length < 2) {
      setSuggestions(null);
      setIsOpen(false);
      setActiveIndex(-1);
      return;
    }

    // 200ms debounce — short enough that the dropdown feels live, long
    // enough that we don't fire a request per keystroke on a fast typer.
    debounceRef.current = setTimeout(() => {
      fetchSuggestions(trimmed);
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchSuggestions]);

  // ── Click outside to close ─────────────────────────────────────────────────

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ── Keyboard navigation (consumer must forward keydown via onKeyDown
  //    on the parent input/form for arrow-key navigation to work). The
  //    listener is attached to the dropdown container as a fallback for
  //    when the dropdown itself has focus. ─────────────────────────────────
  const totalItems = suggestions?.length ?? 0;
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (!isOpen) return;

      if (e.key === 'Escape') {
        setIsOpen(false);
        setActiveIndex(-1);
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex(prev => (prev + 1) % Math.max(1, totalItems));
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(prev => (prev <= 0 ? totalItems - 1 : prev - 1));
        return;
      }

      if (e.key === 'Enter' && activeIndex >= 0 && activeIndex < totalItems && suggestions) {
        e.preventDefault();
        const item = suggestions[activeIndex];
        window.location.href = storeUrl(`/products/${item.slug}`);
        setIsOpen(false);
        onSelect?.();
      }
    },
    [isOpen, totalItems, activeIndex, suggestions, storeUrl, onSelect]
  );

  // ── Nothing to render ──────────────────────────────────────────────────────

  if (!isOpen && !isLoading) return null;

  const hasResults = suggestions && suggestions.length > 0;
  const isEmpty = suggestions !== null && !hasResults && !isLoading;

  return (
    <div
      ref={containerRef}
      className="absolute top-full left-0 right-0 z-50 mt-1 max-h-[70vh] overflow-y-auto overscroll-contain rounded-xl border border-border bg-background shadow-xl"
      role="listbox"
      aria-label={t('Search suggestions', 'اقتراحات البحث')}
      onKeyDown={handleKeyDown}
    >
      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center gap-2 px-4 py-3 text-sm text-muted-foreground">
          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
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
          {t('Searching...', 'جارٍ البحث...')}
        </div>
      )}

      {/* Empty state — "No products found" per spec */}
      {isEmpty && (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          {t('No products found', 'لا توجد منتجات')}
        </div>
      )}

      {/* Results */}
      {!isLoading && hasResults && suggestions && (
        <div>
          {suggestions.map((product, idx) => {
            const isActive = activeIndex === idx;
            const displayName = isAr && product.nameAr ? product.nameAr : product.name;
            // Prices stored in piastres — divide by 1000 for EGP.
            const priceMajor = money(product.price);

            return (
              <Link
                key={product.id}
                href={storeUrl(`/products/${product.slug}`)}
                role="option"
                aria-selected={isActive}
                className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-muted ${
                  isActive ? 'bg-muted' : ''
                }`}
                onClick={() => {
                  setIsOpen(false);
                  onSelect?.();
                }}
              >
                {/* Thumbnail */}
                <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
                  {product.image ? (
                    <Image
                      src={product.image}
                      alt={displayName}
                      width={48}
                      height={48}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                      <svg
                        className="h-5 w-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                        />
                      </svg>
                    </div>
                  )}
                </div>

                {/* Name + price */}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">{displayName}</p>
                  <p className="text-xs text-muted-foreground">{priceMajor} EGP</p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
