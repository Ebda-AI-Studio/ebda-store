'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { BulkExportPanel } from './_components/BulkExportPanel';
import { BulkImportWizard } from './_components/BulkImportWizard';
import { BulkTabs } from './_components/BulkTabs';
import type { BulkTab } from './_components/types';
import { useBulkOperations } from './_hooks/useBulkOperations';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';

export default function BulkOperationsPage() {
  // Hide this page when the super_admin disabled the bulk_operations feature for
  // this store. The hook redirects to the store dashboard if disabled.
  useRequireFeature('bulk_operations');

  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;

  const tPage = useT('bulk.page');
  const tErrors = useT('bulk.errors');

  const [activeTab, setActiveTab] = useState<BulkTab>('import');

  const {
    isImporting,
    isExporting,
    importResult,
    importProgress,
    downloadTemplate,
    importFile,
    exportProducts,
    exportProductsXlsx,
    clearImportResult,
  } = useBulkOperations({
    storeId,
    networkErrorMessage: tErrors('network'),
    importFailedMessage: tErrors('importFailed'),
  });

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle')}
      actions={
        <Button variant="outline" onClick={() => router.push(`/stores/${storeId}`)}>
          <span className="inline-flex items-center gap-2">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            {tPage('backToStore')}
          </span>
        </Button>
      }
    >
      <BulkTabs activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === 'import' && (
        <BulkImportWizard
          isImporting={isImporting}
          importResult={importResult}
          importProgress={importProgress}
          onDownloadTemplate={downloadTemplate}
          onImport={importFile}
          onClearResult={clearImportResult}
          onViewProducts={() => router.push(`/stores/${storeId}/products`)}
        />
      )}

      {activeTab === 'export' && (
        <BulkExportPanel
          isExporting={isExporting}
          onExport={exportProducts}
          onExportXlsx={exportProductsXlsx}
        />
      )}
    </AdminLayout>
  );
}
