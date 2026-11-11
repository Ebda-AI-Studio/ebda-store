'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';

interface StoresEmptyProps {
  search: string;
  statusFilter: string;
}

export function StoresEmpty({ search, statusFilter }: StoresEmptyProps) {
  const t = useT('stores.list');
  const hasFilters = Boolean(search) || statusFilter !== 'all';

  return (
    <div className="force-card py-16">
      <div className="flex flex-col items-center text-center">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-lg bg-gradient-to-br from-primary/20 to-primary/5">
          <svg
            className="h-10 w-10 text-primary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
            />
          </svg>
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">{t('emptyTitle')}</h3>
        <p className="text-muted-foreground mb-6 max-w-sm">
          {hasFilters ? t('emptyHintSearch') : t('emptyHintDefault')}
        </p>
        <Link href="/stores/new">
          <Button className="gap-2 shadow-lg shadow-primary/25">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            {t('emptyCta')}
          </Button>
        </Link>
      </div>
    </div>
  );
}
