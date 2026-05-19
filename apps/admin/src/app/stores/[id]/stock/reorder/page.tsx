'use client';

import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';

export default function ReorderPage() {
  const t = useT('stock.reorder');

  return (
    <AdminLayout title={t('title')}>
      <div className="max-w-2xl space-y-6">
        <p className="text-muted-foreground text-sm">{t('comingSoon')}</p>

        <div className="rounded-xl border border-border bg-muted/10 p-5 space-y-3">
          <h2 className="text-sm font-semibold">How it will work</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">{t('explainer')}</p>
        </div>

        <button
          type="button"
          disabled
          className="px-4 py-2 rounded bg-primary/40 text-primary-foreground text-sm cursor-not-allowed opacity-60"
        >
          {t('notify')}
        </button>
      </div>
    </AdminLayout>
  );
}
