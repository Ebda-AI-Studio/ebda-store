'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import { Input } from '@ebda/ui';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { apiGet } from '../../../../../../../lib/api';

export interface ProductSummary {
  id: string;
  name: string;
  nameAr?: string | null;
  price: number;
  images: { url: string }[];
  status: string;
}

interface ProductSearchProps {
  storeId: string;
  onSelect: (product: ProductSummary) => void;
  excludeIds: string[];
  disabled?: boolean;
}

export function ProductSearch({ storeId, onSelect, excludeIds, disabled }: ProductSearchProps) {
  const t = useT('products.recommendations.search');
  const locale = useLocale();
  const isRtl = locale === 'ar';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const search = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        setOpen(false);
        return;
      }
      setSearching(true);
      try {
        const { data } = await apiGet<{ products: ProductSummary[] }>(
          `/api/v1/stores/${storeId}/products?search=${encodeURIComponent(q)}&limit=25`
        );
        const filtered = (data?.products ?? []).filter(p => !excludeIds.includes(p.id));
        setResults(filtered);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    [storeId, excludeIds]
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (product: ProductSummary) => {
    onSelect(product);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-sm font-medium text-foreground mb-1">{t('label')}</label>
      <div className="relative">
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('placeholder')}
          disabled={disabled}
          onFocus={() => results.length > 0 && setOpen(true)}
        />
        {searching && (
          <div className="absolute end-3 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border bg-card shadow-lg max-h-60 overflow-y-auto overscroll-contain">
          {results.map(product => (
            <button
              key={product.id}
              type="button"
              onClick={() => handleSelect(product)}
              data-ui="row"
              className="flex w-full items-center gap-3 px-3 py-2 hover:bg-muted text-start"
            >
              <div className="h-8 w-8 rounded-md bg-muted overflow-hidden flex-shrink-0">
                {product.images?.[0] ? (
                  <Image
                    src={product.images[0].url}
                    alt={
                      isRtl ? product.nameAr || product.name : product.name || product.nameAr || ''
                    }
                    width={32}
                    height={32}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full flex items-center justify-center text-muted-foreground">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
              <span className="text-sm text-foreground truncate">
                {isRtl ? product.nameAr || product.name : product.name || product.nameAr}
              </span>
            </button>
          ))}
        </div>
      )}

      {open && !searching && query.trim() && results.length === 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border bg-card shadow-lg px-3 py-4 text-center text-sm text-muted-foreground">
          {t('noResults')}
        </div>
      )}
    </div>
  );
}
