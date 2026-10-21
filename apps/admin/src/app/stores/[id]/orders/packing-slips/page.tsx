'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { PackingSlipViewer } from '../../../../../components/orders/PackingSlipViewer';

/** Bulk print: `?ids=<uuid>,<uuid>...` (the selection on the orders list; the API caps it at 100). */
export default function BulkPackingSlipsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const ids = (useSearchParams()?.get('ids') ?? '').split(',').filter(Boolean);
  const t = useT('packingSlip');
  return (
    <AdminLayout mode="store_admin" storeId={storeId} title={t('title')}>
      <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6">
        <PackingSlipViewer storeId={storeId} orderIds={ids} />
      </div>
    </AdminLayout>
  );
}
