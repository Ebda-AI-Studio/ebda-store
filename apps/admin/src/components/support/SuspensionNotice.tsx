'use client';

/**
 * Shown on every store page while the store is suspended (SELF-SERVICE A13): the reason staff recorded, and one
 * appeal form. Renders nothing for a store that is not suspended (the API answers 404). Staff decide the appeal.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { apiGetQuiet } from '@/lib/api';
import { RequestForm } from './RequestForm';

interface Suspension {
  kind: 'policy' | 'billing';
  reason: string | null;
  suspendedAt: string | null;
  appeal: { status: string; createdAt: string } | null;
}

export function SuspensionNotice({ storeId }: { storeId: string }) {
  const t = useT('components.support');
  const [s, setS] = useState<Suspension | null>(null);
  const [form, setForm] = useState(false);

  useEffect(() => {
    if (!storeId) return;
    let live = true;
    void apiGetQuiet<Suspension>(`/api/v1/stores/${storeId}/suspension`).then(r => {
      if (live) setS(r.data ?? null);
    });
    return () => {
      live = false;
    };
  }, [storeId]);

  if (!s) return null;
  return (
    <section
      role="alert"
      className="border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-sm lg:px-6"
    >
      <p className="font-semibold text-destructive-ink">{t('suspended.title')}</p>
      <p className="mt-1 text-foreground">
        {s.reason ? t(`suspended.reason.${s.kind}`, { reason: s.reason }) : t('suspended.noReason')}
      </p>
      {s.kind === 'billing' ? (
        <p className="mt-1 text-muted-foreground">{t('suspended.billingHint')}</p>
      ) : s.appeal?.status === 'open' ? (
        <p className="mt-1 text-muted-foreground">{t('suspended.appealOpen')}</p>
      ) : form ? (
        <div className="mt-3 max-w-xl">
          <RequestForm
            mode="appeal"
            storeId={storeId}
            onDone={() =>
              setS({ ...s, appeal: { status: 'open', createdAt: new Date().toISOString() } })
            }
            onCancel={() => setForm(false)}
          />
        </div>
      ) : (
        <Button className="mt-2" variant="outline" type="button" onClick={() => setForm(true)}>
          {t('suspended.appeal')}
        </Button>
      )}
    </section>
  );
}
