'use client';

import { useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Input, Label } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiPost, getApiUrl } from '../../../../lib/api';

interface ImportResult {
  total: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ row: number; error: string }>;
}

export default function BulkOperationsPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;

  const [activeTab, setActiveTab] = useState<'import' | 'export'>('import');
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [updateExisting, setUpdateExisting] = useState(true);
  const [csvContent, setCsvContent] = useState('');
  const [xlsxBase64, setXlsxBase64] = useState('');
  const [selectedFileName, setSelectedFileName] = useState('');
  const [fileKind, setFileKind] = useState<'csv' | 'xlsx' | null>(null);
  const [skuPrefix, setSkuPrefix] = useState('');
  const [defaultInventory, setDefaultInventory] = useState(100);
  const [defaultStatus, setDefaultStatus] = useState<'draft' | 'active'>('active');
  const [trackInventory, setTrackInventory] = useState(false);
  const [exportFilters, setExportFilters] = useState({
    status: '',
    search: '',
    includeDeleted: false,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleDownloadTemplate() {
    try {
      const response = await fetch(`${getApiUrl()}/api/v1/stores/${storeId}/bulk/template`, {
        credentials: 'include',
      });

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'product_import_template.csv';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }
    } catch (error) {
      console.error('Failed to download template:', error);
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFileName(file.name);
    const isXlsx = /\.xlsx$/i.test(file.name) || file.type.includes('sheet');

    if (isXlsx) {
      setFileKind('xlsx');
      setCsvContent('');
      const buf = await file.arrayBuffer();
      // Chunked base64 encode so we don't blow the stack on large files.
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      setXlsxBase64(btoa(binary));
    } else {
      setFileKind('csv');
      setXlsxBase64('');
      const reader = new FileReader();
      reader.onload = event => {
        const content = event.target?.result as string;
        setCsvContent(content);
      };
      reader.readAsText(file);
    }
  }

  async function handleImport() {
    if (fileKind === 'xlsx' ? !xlsxBase64 : !csvContent) return;

    setIsImporting(true);
    setImportResult(null);

    try {
      const isXlsx = fileKind === 'xlsx';
      const endpoint = isXlsx
        ? `/api/v1/stores/${storeId}/bulk/import-xlsx`
        : `/api/v1/stores/${storeId}/bulk/import`;
      const body = isXlsx
        ? {
            xlsxBase64,
            options: {
              updateExisting,
              skuPrefix: skuPrefix.trim() || undefined,
              defaultInventory,
              defaultStatus,
              trackInventory,
            },
          }
        : { csvData: csvContent, options: { updateExisting } };

      const { data, error } = await apiPost<{ result: ImportResult }>(endpoint, body);

      if (data) {
        setImportResult(data.result);
      } else {
        setImportResult({
          total: 0,
          created: 0,
          updated: 0,
          failed: 1,
          errors: [{ row: 0, error: error?.message || 'Import failed' }],
        });
      }
    } catch {
      setImportResult({
        total: 0,
        created: 0,
        updated: 0,
        failed: 1,
        errors: [{ row: 0, error: 'Network error. Please try again.' }],
      });
    } finally {
      setIsImporting(false);
    }
  }

  async function handleExport() {
    setIsExporting(true);

    try {
      const queryParams = new URLSearchParams();
      if (exportFilters.status) queryParams.append('status', exportFilters.status);
      if (exportFilters.search) queryParams.append('search', exportFilters.search);
      if (exportFilters.includeDeleted) queryParams.append('includeDeleted', 'true');

      const response = await fetch(
        `${getApiUrl()}/api/v1/stores/${storeId}/bulk/export?${queryParams}`,
        { credentials: 'include' }
      );

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `products_${storeId}_${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }
    } catch (error) {
      console.error('Failed to export products:', error);
    } finally {
      setIsExporting(false);
    }
  }

  function clearImport() {
    setCsvContent('');
    setXlsxBase64('');
    setSelectedFileName('');
    setFileKind(null);
    setImportResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  return (
    <AdminLayout
      title="Bulk Operations"
      subtitle="Import and export products in bulk"
      actions={
        <Button variant="outline" onClick={() => router.push(`/stores/${storeId}`)}>
          <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          Back to Store
        </Button>
      }
    >
      {/* Tabs */}
      <div className="mb-6 border-b">
        <nav className="flex gap-4">
          <button
            onClick={() => setActiveTab('import')}
            className={`pb-3 text-sm font-medium transition ${
              activeTab === 'import'
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <svg
              className="mr-2 inline-block h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              />
            </svg>
            Import Products
          </button>
          <button
            onClick={() => setActiveTab('export')}
            className={`pb-3 text-sm font-medium transition ${
              activeTab === 'export'
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <svg
              className="mr-2 inline-block h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            Export Products
          </button>
        </nav>
      </div>

      {/* Import Tab */}
      {activeTab === 'import' && (
        <div className="space-y-6">
          {/* Instructions */}
          <div className="rounded-xl border bg-info/5 p-6">
            <h3 className="font-semibold text-info">How to Import Products</h3>
            <ol className="mt-3 list-decimal list-inside space-y-2 text-sm text-info">
              <li>Download the CSV template using the button below</li>
              <li>Fill in your product data following the template format</li>
              <li>Prices are in fils (1 KWD = 1000 fils)</li>
              <li>For multiple categories/tags/images, separate with commas within quotes</li>
              <li>Upload the completed CSV file and click Import</li>
            </ol>
            <div className="mt-4">
              <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>
                <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  />
                </svg>
                Download Template
              </Button>
            </div>
          </div>

          {/* File Upload */}
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h3 className="font-semibold text-foreground mb-4">Upload CSV or XLSX File</h3>

            <div className="space-y-4">
              <div
                className="border-2 border-dashed rounded-lg p-8 text-center hover:border-primary transition cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <svg
                  className="mx-auto h-12 w-12 text-muted-foreground"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="mt-2 text-sm text-muted-foreground">
                  {selectedFileName
                    ? `${selectedFileName} loaded. Click to change.`
                    : 'Click to upload a CSV or XLSX file'}
                </p>
                {fileKind === 'csv' && csvContent && (
                  <p className="mt-1 text-xs text-[hsl(var(--success))]">
                    ✓ {csvContent.split('\n').filter(l => l.trim()).length - 1} products ready for
                    import
                  </p>
                )}
                {fileKind === 'xlsx' && xlsxBase64 && (
                  <p className="mt-1 text-xs text-[hsl(var(--success))]">
                    ✓ Workbook loaded — rows will be mapped + parsed on the server
                  </p>
                )}
              </div>

              {/* Options */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="updateExisting"
                  checked={updateExisting}
                  onChange={e => setUpdateExisting(e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <Label htmlFor="updateExisting" className="text-sm font-normal">
                  Update existing products (match by SKU or slug)
                </Label>
              </div>

              {fileKind === 'xlsx' && (
                <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    XLSX options — applied to rows that don&apos;t specify these columns explicitly.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="skuPrefix" className="text-xs">
                        SKU prefix (e.g. <code>WJ</code> → <code>WJ-001</code>)
                      </Label>
                      <Input
                        id="skuPrefix"
                        value={skuPrefix}
                        onChange={e => setSkuPrefix(e.target.value)}
                        placeholder="ITEM"
                        maxLength={16}
                      />
                    </div>
                    <div>
                      <Label htmlFor="defaultInventory" className="text-xs">
                        Default inventory per row
                      </Label>
                      <Input
                        id="defaultInventory"
                        type="number"
                        min={0}
                        value={defaultInventory}
                        onChange={e =>
                          setDefaultInventory(Math.max(0, parseInt(e.target.value, 10) || 0))
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor="defaultStatus" className="text-xs">
                        Default status
                      </Label>
                      <select
                        id="defaultStatus"
                        value={defaultStatus}
                        onChange={e => setDefaultStatus(e.target.value as 'draft' | 'active')}
                        className="mt-2 block h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="active">active</option>
                        <option value="draft">draft</option>
                      </select>
                    </div>
                    <div className="flex items-end gap-2">
                      <input
                        type="checkbox"
                        id="trackInventory"
                        checked={trackInventory}
                        onChange={e => setTrackInventory(e.target.checked)}
                        className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                      />
                      <Label htmlFor="trackInventory" className="text-sm font-normal">
                        Track inventory (decrement on sale)
                      </Label>
                    </div>
                  </div>
                </div>
              )}

              {/* Import Button */}
              <div className="flex gap-2">
                <Button
                  onClick={handleImport}
                  disabled={isImporting || (fileKind === 'xlsx' ? !xlsxBase64 : !csvContent)}
                  className="flex-1"
                >
                  {isImporting ? (
                    <>
                      <svg className="mr-2 h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                      Importing...
                    </>
                  ) : (
                    <>
                      <svg
                        className="mr-2 h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                        />
                      </svg>
                      Import Products
                    </>
                  )}
                </Button>
                {csvContent && (
                  <Button variant="outline" onClick={clearImport}>
                    Clear
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Import Results */}
          {importResult && (
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h3 className="font-semibold text-foreground mb-4">Import Results</h3>

              <div className="grid gap-4 sm:grid-cols-4 mb-4">
                <div className="text-center p-4 bg-muted rounded-lg">
                  <p className="text-2xl font-bold text-foreground">{importResult.total}</p>
                  <p className="text-xs text-muted-foreground">Total Rows</p>
                </div>
                <div className="text-center p-4 bg-[hsl(var(--success))]/10 rounded-lg">
                  <p className="text-2xl font-bold text-[hsl(var(--success))]">
                    {importResult.created}
                  </p>
                  <p className="text-xs text-muted-foreground">Created</p>
                </div>
                <div className="text-center p-4 bg-info/5 rounded-lg">
                  <p className="text-2xl font-bold text-info">{importResult.updated}</p>
                  <p className="text-xs text-muted-foreground">Updated</p>
                </div>
                <div className="text-center p-4 bg-destructive/10 rounded-lg">
                  <p className="text-2xl font-bold text-destructive">{importResult.failed}</p>
                  <p className="text-xs text-muted-foreground">Failed</p>
                </div>
              </div>

              {importResult.errors.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-sm font-medium text-destructive mb-2">Errors:</h4>
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-destructive/20 bg-destructive/10">
                    {importResult.errors.map((error, i) => (
                      <div
                        key={i}
                        className="px-4 py-2 border-b border-destructive/20 last:border-0 text-sm"
                      >
                        <span className="font-medium text-destructive">Row {error.row}:</span>{' '}
                        <span className="text-destructive">{error.error}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {importResult.created > 0 || importResult.updated > 0 ? (
                <div className="mt-4 p-3 bg-[hsl(var(--success))]/10 rounded-lg text-center">
                  <p className="text-sm text-[hsl(var(--success))]">
                    ✓ Import completed successfully!{' '}
                    <button
                      onClick={() => router.push(`/stores/${storeId}/products`)}
                      className="underline hover:no-underline"
                    >
                      View products
                    </button>
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* Export Tab */}
      {activeTab === 'export' && (
        <div className="space-y-6">
          {/* Export Options */}
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h3 className="font-semibold text-foreground mb-4">Export Options</h3>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <Label htmlFor="exportStatus">Product Status</Label>
                <select
                  id="exportStatus"
                  value={exportFilters.status}
                  onChange={e => setExportFilters(prev => ({ ...prev, status: e.target.value }))}
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">All Statuses</option>
                  <option value="active">Active</option>
                  <option value="draft">Draft</option>
                  <option value="archived">Archived</option>
                </select>
              </div>

              <div>
                <Label htmlFor="exportSearch">Search</Label>
                <Input
                  id="exportSearch"
                  value={exportFilters.search}
                  onChange={e => setExportFilters(prev => ({ ...prev, search: e.target.value }))}
                  placeholder="Search by name or SKU"
                  className="mt-1"
                />
              </div>

              <div className="flex items-end">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="includeDeleted"
                    checked={exportFilters.includeDeleted}
                    onChange={e =>
                      setExportFilters(prev => ({ ...prev, includeDeleted: e.target.checked }))
                    }
                    className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                  />
                  <Label htmlFor="includeDeleted" className="text-sm font-normal">
                    Include deleted products
                  </Label>
                </div>
              </div>
            </div>

            <div className="mt-6">
              <Button onClick={handleExport} disabled={isExporting}>
                {isExporting ? (
                  <>
                    <svg className="mr-2 h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    Exporting...
                  </>
                ) : (
                  <>
                    <svg
                      className="mr-2 h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                      />
                    </svg>
                    Export to CSV
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* Export Info */}
          <div className="rounded-xl border bg-muted p-6">
            <h3 className="font-semibold text-foreground">Export Information</h3>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <svg
                  className="h-5 w-5 text-[hsl(var(--success))] flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                All product fields are included in the export
              </li>
              <li className="flex items-start gap-2">
                <svg
                  className="h-5 w-5 text-[hsl(var(--success))] flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                Categories, tags, and images are comma-separated within their columns
              </li>
              <li className="flex items-start gap-2">
                <svg
                  className="h-5 w-5 text-[hsl(var(--success))] flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                The exported file can be edited and re-imported to update products
              </li>
              <li className="flex items-start gap-2">
                <svg
                  className="h-5 w-5 text-[hsl(var(--success))] flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                Prices are in fils (1 KWD = 1000 fils)
              </li>
            </ul>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
