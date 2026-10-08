'use client';

import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { FiscalDocumentViewer } from '../../../../../components/fiscal/FiscalDocumentViewer';

export default function InvoiceViewerPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const docId = params?.docId as string;
  const t = useT('invoices');

  return (
    <AdminLayout mode="store_admin" storeId={storeId} title={t('viewer.title')}>
      <FiscalDocumentViewer
        endpoint={`/api/v1/stores/${storeId}/fiscal-documents/${docId}/html`}
        backHref={`/stores/${storeId}/invoices`}
      />
    </AdminLayout>
  );
}
