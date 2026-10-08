'use client';

import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { RequireSuperAdmin } from '../../../../components/RequireSuperAdmin';
import { FiscalDocumentViewer } from '../../../../components/fiscal/FiscalDocumentViewer';

export default function TaxArchiveDocumentPage() {
  const params = useParams();
  const storeId = params?.storeId as string;
  const docId = params?.docId as string;
  const t = useT('invoices');

  return (
    <AdminLayout title={t('viewer.title')} mode="super_admin">
      <RequireSuperAdmin>
        <FiscalDocumentViewer
          endpoint={`/api/v1/admin/fiscal-archive/${storeId}/${docId}/html`}
          backHref={`/tax-archive/${storeId}`}
        />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
