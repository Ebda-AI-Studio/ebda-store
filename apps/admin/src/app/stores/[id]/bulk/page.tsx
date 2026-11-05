'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { BulkExportPanel } from './_components/BulkExportPanel';
import { BulkImportWizard } from './_components/BulkImportWizard';
import { BulkTabs } from './_components/BulkTabs';
import { CatalogImportPanel } from './_components/CatalogImportPanel';
import type { BulkTab } from './_components/types';
import { useBulkOperations } from './_hooks/useBulkOperations';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';

export default function BulkOperationsPage() {
  const { gate } = useRequireFeature('bulk_operations');

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
    preview,
    isPreviewing,
    previewError,
    previewFile,
    clearPreview,
    exportProducts,
    exportProductsXlsx,
    clearImportResult,
  } = useBulkOperations({
    storeId,
    networkErrorMessage: tErrors('network'),
    importFailedMessage: tErrors('importFailed'),
  });

  if (gate) return gate;

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      <BulkTabs activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === 'import' && (
        <BulkImportWizard
          isImporting={isImporting}
          importResult={importResult}
          importProgress={importProgress}
          onDownloadTemplate={downloadTemplate}
          preview={preview}
          isPreviewing={isPreviewing}
          previewError={previewError}
          onPreview={previewFile}
          onClearPreview={clearPreview}
          onImport={importFile}
          onClearResult={clearImportResult}
          onViewProducts={() => router.push(`/stores/${storeId}/products`)}
        />
      )}

      {activeTab === 'catalog' && <CatalogImportPanel storeId={storeId} />}

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
