'use client';

import { Button } from '@/components/ui/Button';
import type { PageMeta } from '@/lib/api';
import { useT } from '@/i18n/useT';

/**
 * Prev / "Page x of y" / Next for a list whose route answers `{ data, meta }` (read with
 * `apiGetPage`). Renders nothing for a single page. The arrows flip under RTL. Shared by the
 * lists that gained a pager in issue 2430; the expenses list carries its own inline copy.
 */
export function PageControls({
  meta,
  onPageChange,
}: {
  meta: PageMeta | null;
  onPageChange: (page: number) => void;
}) {
  const t = useT('common.pager');
  if (!meta || meta.totalPages <= 1) return null;
  return (
    <div className="mt-4 flex items-center gap-2 text-sm">
      <Button
        variant="outline"
        type="button"
        disabled={meta.page <= 1}
        onClick={() => onPageChange(meta.page - 1)}
        aria-label={t('previous')}
      >
        <span aria-hidden="true" className="inline-block rtl:rotate-180">
          ←
        </span>
      </Button>
      <span className="text-muted-foreground">
        {t('pageOf', { page: meta.page, totalPages: meta.totalPages })}
      </span>
      <Button
        variant="outline"
        type="button"
        disabled={meta.page >= meta.totalPages}
        onClick={() => onPageChange(meta.page + 1)}
        aria-label={t('next')}
      >
        <span aria-hidden="true" className="inline-block rtl:rotate-180">
          →
        </span>
      </Button>
    </div>
  );
}
