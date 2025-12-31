'use client';

import { useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Input, Label } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';

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
  const [exportFilters, setExportFilters] = useState({
    status: '',
    search: '',
    includeDeleted: false,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleDownloadTemplate() {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/bulk/template`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

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

    const reader = new FileReader();
    reader.onload = event => {
      const content = event.target?.result as string;
      setCsvContent(content);
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!csvContent) return;

    setIsImporting(true);
    setImportResult(null);

    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/bulk/import`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            csvData: csvContent,
            options: { updateExisting },
          }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        setImportResult(data.data.result);
      } else {
        const error = await response.json();
        setImportResult({
          total: 0,
          created: 0,
          updated: 0,
          failed: 1,
          errors: [{ row: 0, error: error.error?.message || 'Import failed' }],
        });
      }
    } catch (error) {
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
      const token = localStorage.getItem('authToken');
      const queryParams = new URLSearchParams();
      if (exportFilters.status) queryParams.append('status', exportFilters.status);
      if (exportFilters.search) queryParams.append('search', exportFilters.search);
      if (exportFilters.includeDeleted) queryParams.append('includeDeleted', 'true');

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/bulk/export?${queryParams}`,
        { headers: { Authorization: `Bearer ${token}` } }
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
                : 'text-gray-500 hover:text-gray-700'
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
                : 'text-gray-500 hover:text-gray-700'
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
          <div className="rounded-xl border bg-blue-50 p-6">
            <h3 className="font-semibold text-blue-900">How to Import Products</h3>
            <ol className="mt-3 list-decimal list-inside space-y-2 text-sm text-blue-800">
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
          <div className="rounded-xl border bg-white p-6 shadow-sm">
            <h3 className="font-semibold text-gray-900 mb-4">Upload CSV File</h3>

            <div className="space-y-4">
              <div
                className="border-2 border-dashed rounded-lg p-8 text-center hover:border-primary transition cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <svg
                  className="mx-auto h-12 w-12 text-gray-400"
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
                <p className="mt-2 text-sm text-gray-600">
                  {csvContent ? 'File loaded. Click to change.' : 'Click to upload CSV file'}
                </p>
                {csvContent && (
                  <p className="mt-1 text-xs text-green-600">
                    ✓ {csvContent.split('\n').filter(l => l.trim()).length - 1} products ready for
                    import
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
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <Label htmlFor="updateExisting" className="text-sm font-normal">
                  Update existing products (match by SKU or slug)
                </Label>
              </div>

              {/* Import Button */}
              <div className="flex gap-2">
                <Button
                  onClick={handleImport}
                  disabled={!csvContent || isImporting}
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
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h3 className="font-semibold text-gray-900 mb-4">Import Results</h3>

              <div className="grid gap-4 sm:grid-cols-4 mb-4">
                <div className="text-center p-4 bg-gray-50 rounded-lg">
                  <p className="text-2xl font-bold text-gray-900">{importResult.total}</p>
                  <p className="text-xs text-gray-500">Total Rows</p>
                </div>
                <div className="text-center p-4 bg-green-50 rounded-lg">
                  <p className="text-2xl font-bold text-green-600">{importResult.created}</p>
                  <p className="text-xs text-gray-500">Created</p>
                </div>
                <div className="text-center p-4 bg-blue-50 rounded-lg">
                  <p className="text-2xl font-bold text-blue-600">{importResult.updated}</p>
                  <p className="text-xs text-gray-500">Updated</p>
                </div>
                <div className="text-center p-4 bg-red-50 rounded-lg">
                  <p className="text-2xl font-bold text-red-600">{importResult.failed}</p>
                  <p className="text-xs text-gray-500">Failed</p>
                </div>
              </div>

              {importResult.errors.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-sm font-medium text-red-900 mb-2">Errors:</h4>
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-red-200 bg-red-50">
                    {importResult.errors.map((error, i) => (
                      <div
                        key={i}
                        className="px-4 py-2 border-b border-red-100 last:border-0 text-sm"
                      >
                        <span className="font-medium text-red-700">Row {error.row}:</span>{' '}
                        <span className="text-red-600">{error.error}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {importResult.created > 0 || importResult.updated > 0 ? (
                <div className="mt-4 p-3 bg-green-50 rounded-lg text-center">
                  <p className="text-sm text-green-700">
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
          <div className="rounded-xl border bg-white p-6 shadow-sm">
            <h3 className="font-semibold text-gray-900 mb-4">Export Options</h3>

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
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
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
          <div className="rounded-xl border bg-gray-50 p-6">
            <h3 className="font-semibold text-gray-900">Export Information</h3>
            <ul className="mt-3 space-y-2 text-sm text-gray-600">
              <li className="flex items-start gap-2">
                <svg
                  className="h-5 w-5 text-green-500 flex-shrink-0"
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
                  className="h-5 w-5 text-green-500 flex-shrink-0"
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
                  className="h-5 w-5 text-green-500 flex-shrink-0"
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
                  className="h-5 w-5 text-green-500 flex-shrink-0"
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
