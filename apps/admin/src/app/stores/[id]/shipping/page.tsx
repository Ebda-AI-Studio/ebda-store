'use client';

import { useCallback, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { StickySaveBar } from '../../../../components/StickySaveBar';
import { useFeatures } from '../../../../hooks/useFeatures';
import { AreaRateEditor, type AreaRateEditorHandle } from './_components/AreaRateEditor';
import { ReturnPolicyCard, type ReturnPolicyHandle } from './_components/ReturnPolicyCard';
import { ShippingTabs } from './_components/ShippingTabs';

/**
 * "الشحن والتوصيل" > الأسعار. One Save for the whole page (rule 5): the area rates and the return policy are saved
 * together from the sticky bar, which shows only while something changed.
 */
export default function ShippingSettingsPage() {
  const params = useParams();
  const storeId = params.id as string;
  const tPage = useT('shipping.page');
  const tHub = useT('shippingHub');
  const { isEnabled } = useFeatures();
  const carriersEnabled = isEnabled('shipping_carriers');
  const { success: toastSuccess } = useToast();

  const ratesRef = useRef<AreaRateEditorHandle>(null);
  const policyRef = useRef<ReturnPolicyHandle>(null);
  const [ratesDirty, setRatesDirty] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const saveAll = useCallback(async () => {
    setSaving(true);
    try {
      // Policy first: it is a single quick write and a validation error there should stop before the big grid save.
      if (policyDirty && !(await policyRef.current?.save())) return;
      if (ratesDirty && !(await ratesRef.current?.save())) return;
      // The rates editor toasts its own success; a policy-only save needs one too.
      if (!ratesDirty) toastSuccess(tHub('savedTitle'), tHub('savedBody'));
    } finally {
      setSaving(false);
    }
  }, [policyDirty, ratesDirty, toastSuccess, tHub]);

  const resetAll = useCallback(() => {
    ratesRef.current?.reset();
    policyRef.current?.reset();
  }, []);

  return (
    <AdminLayout title={tHub('title')} subtitle={tHub('subtitle')}>
      <ShippingTabs />
      <div className="space-y-6 pb-24">
        <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          {tPage('intro')}
        </div>

        {carriersEnabled && (
          <p className="text-sm text-muted-foreground">
            {tPage('carriersBannerHint')}{' '}
            <Link
              href={`/stores/${storeId}/shipping-carriers`}
              className="font-medium text-primary-ink underline underline-offset-2"
            >
              {tPage('carriersBannerLink')}
            </Link>
          </p>
        )}

        <div data-setting-id="shipping.area-rates">
          <AreaRateEditor ref={ratesRef} storeId={storeId} onDirtyChange={setRatesDirty} />
        </div>

        {/* Return policy sits with shipping: both are the delivery-and-returns promise a buyer (or their AI agent)
            evaluates before purchase. */}
        <ReturnPolicyCard ref={policyRef} storeId={storeId} onDirtyChange={setPolicyDirty} />
      </div>
      <StickySaveBar
        dirty={ratesDirty || policyDirty}
        onSave={saveAll}
        onReset={resetAll}
        saving={saving}
        saveLabel={tHub('saveLabel')}
      />
    </AdminLayout>
  );
}
