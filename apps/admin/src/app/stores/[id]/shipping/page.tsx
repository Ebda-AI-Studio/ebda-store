'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useFeatures } from '../../../../hooks/useFeatures';
import { AreaRateEditor } from './_components/AreaRateEditor';

export default function ShippingSettingsPage() {
  const params = useParams();
  const storeId = params.id as string;
  const tPage = useT('shipping.page');
  const tAreaRates = useT('shipping.areaRates');
  const { isEnabled } = useFeatures();
  const carriersEnabled = isEnabled('shipping_carriers');

  return (
    <AdminLayout title={tAreaRates('sectionTitle')} subtitle={tAreaRates('sectionSubtitle')}>
      <div className="space-y-6">
        <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          {tPage('intro')}
        </div>

        {/* Shipping Carriers callout — visible only when the feature is enabled.
            The carriers page lives at /stores/[id]/shipping-carriers and is
            intentionally separate (carrier credentials + shipment tracking).
            This banner bridges discoverability since both pages share the
            "Shipping" sidebar group. */}
        {carriersEnabled && (
          <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0 w-8 h-8 bg-cyan-100 rounded-full flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-cyan-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"
                  />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-cyan-900">Shipping Carriers enabled</p>
                <p className="text-xs text-cyan-700">
                  Configure iCarry &amp; Aramex credentials, test connections, and view shipments.
                </p>
              </div>
            </div>
            <Link
              href={`/stores/${storeId}/shipping-carriers`}
              className="flex-shrink-0 px-3 py-1.5 text-sm font-medium text-cyan-700 border border-cyan-300 rounded-lg hover:bg-cyan-100 transition-colors"
            >
              Manage carriers →
            </Link>
          </div>
        )}

        {/* ── Area rates editor (sole shipping CRUD) ────────────────────── */}
        <AreaRateEditor storeId={storeId} />
      </div>
    </AdminLayout>
  );
}
