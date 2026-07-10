'use client';

import type { PaginationMeta } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';

interface ProductsPaginationProps {
  meta: PaginationMeta;
  page: number;
  onPageChange: (page: number) => void;
}

export function ProductsPagination({ meta, page, onPageChange }: ProductsPaginationProps) {
  const { language } = useLanguage();
  const { localize } = useNumerals();
  const t = (en: string, ar: string) => (language === 'ar' ? ar : en);

  if (meta.totalPages <= 1) return null;

  return (
    <div className="mt-8 flex items-center justify-center gap-2">
      <button
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page === 1}
        className="min-h-11 rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t('Previous', 'السابق')}
      </button>
      {Array.from({ length: meta.totalPages }, (_, i) => i + 1)
        .filter(p => p === 1 || p === meta.totalPages || Math.abs(p - page) <= 1)
        .map((p, i, arr) => {
          const showEllipsis = i > 0 && p - arr[i - 1] > 1;
          return (
            <span key={p} className="flex items-center gap-2">
              {showEllipsis && <span className="px-1 text-muted-foreground">...</span>}
              <button
                onClick={() => onPageChange(p)}
                className={`flex h-11 w-11 items-center justify-center rounded-lg text-sm font-medium transition-colors ${
                  page === p ? 'bg-primary text-white' : 'border border-border hover:bg-muted'
                }`}
              >
                {localize(p)}
              </button>
            </span>
          );
        })}
      <button
        onClick={() => onPageChange(Math.min(meta.totalPages, page + 1))}
        disabled={page === meta.totalPages}
        className="min-h-11 rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t('Next', 'التالي')}
      </button>
    </div>
  );
}
