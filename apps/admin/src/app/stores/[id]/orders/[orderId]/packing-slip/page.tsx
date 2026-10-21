'use client';

import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { PackingSlipViewer } from '../../../../../../components/orders/PackingSlipViewer';

/** Print the packing slip of one order. */
export default function OrderPackingSlipPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const orderId = params?.orderId as string;
  const t = useT('packingSlip');
  return (
    <AdminLayout mode="store_admin" storeId={storeId} title={t('title')}>
      <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6">
        <PackingSlipViewer storeId={storeId} orderIds={[orderId]} />
      </div>
    </AdminLayout>
  );
}
