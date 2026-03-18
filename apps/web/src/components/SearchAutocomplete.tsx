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
import { useStore, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductSuggestion {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  price: number;
  images: Array<{ id: string; url: string; alt?: string }>;
}

interface CategorySuggestion {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
}

interface Suggestions {
  products: ProductSuggestion[];
  categories: CategorySuggestion[];
}

type SuggestionItem =
  | { kind: 'product'; data: ProductSuggestion }
  | { kind: 'category'; data: CategorySuggestion };

// ─── Props ────────────────────────────────────────────────────────────────────

interface SearchAutocompleteProps {
  query: string;
  onSelect?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SearchAutocomplete({ query, onSelect }: SearchAutocompleteProps) {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();

  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build flat list of all items for keyboard navigation
  const items: SuggestionItem[] = suggestions
    ? [
        ...suggestions.products.map(p => ({ kind: 'product' as const, data: p })),
        ...suggestions.categories.map(c => ({ kind: 'category' as const, data: c })),
      ]
    : [];

  const totalItems = items.length;

  // ── Fetch suggestions with debounce ────────────────────────────────────────

  const fetchSuggestions = useCallback(
    async (q: string) => {
      if (!store.id || store.id === 'demo') return;

      setIsLoading(true);
      try {
        const sessionId =
          typeof window !== 'undefined' ? (localStorage.getItem('sessionId') ?? 'anon') : 'anon';

        const url = `${API_URL}/stores/${store.id}/products/suggestions?q=${encodeURIComponent(q)}&limit=5`;
        const res = await fetch(url, {
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-ID': sessionId,
            'X-Store-ID': store.id,
          },
        });

        if (!res.ok) {
          setSuggestions(null);
          return;
        }

        const json = await res.json();
        if (json.success && json.data?.suggestions) {
          setSuggestions(json.data.suggestions);
          setIsOpen(true);
          setActiveIndex(-1);
        } else {
          setSuggestions(null);
        }
      } catch {
        setSuggestions(null);
      } finally {
        setIsLoading(false);
      }
    },
    [store.id]
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();

    if (trimmed.length < 2) {
      setSuggestions(null);
      setIsOpen(false);
      setActiveIndex(-1);
      return;
    }

    debounceRef.current = setTimeout(() => {
      fetchSuggestions(trimmed);
    }, 300);

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

  // ── Keyboard navigation ────────────────────────────────────────────────────

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
        setActiveIndex(prev => (prev + 1) % totalItems);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(prev => (prev <= 0 ? totalItems - 1 : prev - 1));
        return;
      }

      if (e.key === 'Enter' && activeIndex >= 0 && activeIndex < totalItems) {
        e.preventDefault();
        const item = items[activeIndex];
        if (item.kind === 'product') {
          window.location.href = storeUrl(`/products/${item.data.slug}`);
        } else {
          window.location.href = storeUrl(`/products?category=${item.data.slug}`);
        }
        setIsOpen(false);
        onSelect?.();
      }
    },
    [isOpen, totalItems, activeIndex, items, storeUrl, onSelect]
  );

  // ── Nothing to render ──────────────────────────────────────────────────────

  if (!isOpen && !isLoading) return null;

  const hasResults =
    suggestions && (suggestions.products.length > 0 || suggestions.categories.length > 0);
  const isEmpty = suggestions && !hasResults;

  return (
    <div
      ref={containerRef}
      className="absolute top-full left-0 right-0 z-50 mt-1 overflow-hidden rounded-xl border border-border bg-background shadow-xl"
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

      {/* Empty state */}
      {!isLoading && isEmpty && (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          {t(`No results for "${query.trim()}"`, `لا نتائج لـ "${query.trim()}"`)}
        </div>
      )}

      {/* Results */}
      {!isLoading && hasResults && (
        <>
          {/* Product suggestions */}
          {suggestions.products.length > 0 && (
            <div>
              <p className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('Products', 'المنتجات')}
              </p>
              {suggestions.products.map((product, idx) => {
                const itemIndex = idx;
                const isActive = activeIndex === itemIndex;
                const displayName = t(product.name, product.nameAr || product.name);
                const priceKwd = (product.price / 1000).toFixed(3);

                return (
                  <Link
                    key={product.id}
                    href={storeUrl(`/products/${product.slug}`)}
                    role="option"
                    aria-selected={isActive}
                    className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-muted ${
                      isActive ? 'bg-muted' : ''
                    }`}
                    onClick={() => {
                      setIsOpen(false);
                      onSelect?.();
                    }}
                  >
                    {/* Thumbnail */}
                    <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
                      {product.images?.[0]?.url ? (
                        <Image
                          src={product.images[0].url}
                          alt={product.images[0].alt || displayName}
                          width={40}
                          height={40}
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
                      <p className="text-xs text-muted-foreground">{priceKwd} KWD</p>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Category suggestions */}
          {suggestions.categories.length > 0 && (
            <div className="border-t border-border">
              <p className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('Categories', 'الفئات')}
              </p>
              {suggestions.categories.map((category, idx) => {
                const itemIndex = suggestions.products.length + idx;
                const isActive = activeIndex === itemIndex;
                const displayName = t(category.name, category.nameAr || category.name);

                return (
                  <Link
                    key={category.id}
                    href={storeUrl(`/products?category=${category.slug}`)}
                    role="option"
                    aria-selected={isActive}
                    className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-muted ${
                      isActive ? 'bg-muted' : ''
                    }`}
                    onClick={() => {
                      setIsOpen(false);
                      onSelect?.();
                    }}
                  >
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <svg
                        className="h-5 w-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                        />
                      </svg>
                    </div>
                    <span className="font-medium text-foreground">{displayName}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
