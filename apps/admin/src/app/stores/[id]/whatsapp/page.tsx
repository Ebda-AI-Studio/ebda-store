'use client';

/**
 * Master WhatsApp Integration page — Phase 7.1.
 *
 * Consolidates all 4 WhatsApp sub-pages into a single tabbed view:
 *   ?tab=connection     — connect WBS API key + template selection
 *   ?tab=templates      — generate + sync Meta templates
 *   ?tab=order-updates  — per-event toggle configuration
 *   ?tab=payment-link   — merchant-initiated payment links
 *
 * The 4 old page paths redirect here (thin redirect components).
 */

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';
import { ConnectionTab } from '../../../../components/whatsapp/ConnectionTab';
import { TemplatesTab } from '../../../../components/whatsapp/TemplatesTab';
import { OrderUpdatesTab } from '../../../../components/whatsapp/OrderUpdatesTab';
import { PaymentLinkTab } from '../../../../components/whatsapp/PaymentLinkTab';
import { BotCopyTab } from '../../../../components/whatsapp/BotCopyTab';
import { BotAnalyticsTab } from '../../../../components/whatsapp/BotAnalyticsTab';

// ─── Tab definitions ──────────────────────────────────────────────────────────

type TabKey =
  | 'connection'
  | 'templates'
  | 'order-updates'
  | 'payment-link'
  | 'bot-copy'
  | 'bot-analytics';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'connection', label: 'Connection' },
  { key: 'templates', label: 'Templates' },
  { key: 'order-updates', label: 'Order Updates' },
  { key: 'payment-link', label: 'Payment Link' },
  { key: 'bot-copy', label: 'Bot Copy' },
  { key: 'bot-analytics', label: 'Bot Analytics' },
];

function isValidTab(value: string | null): value is TabKey {
  return (
    value === 'connection' ||
    value === 'templates' ||
    value === 'order-updates' ||
    value === 'payment-link' ||
    value === 'bot-copy' ||
    value === 'bot-analytics'
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function WhatsAppMasterPage() {
  const params = useParams<{ id: string }>();
  const storeId = params.id;
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawTab = searchParams.get('tab');
  const activeTab: TabKey = isValidTab(rawTab) ? rawTab : 'connection';

  const switchTab = (key: TabKey) => {
    router.replace(`/stores/${storeId}/whatsapp?tab=${key}`);
  };

  return (
    <AdminLayout
      title="WhatsApp Integration"
      subtitle="Force WhatsApp Business Platform · templates · order updates · payment links"
    >
      {/* Tab strip */}
      <div className="border-b border-border mb-6">
        <nav className="-mb-px flex gap-1 overflow-x-auto" role="tablist">
          {TABS.map(tab => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => switchTab(tab.key)}
              className={`whitespace-nowrap px-4 py-2.5 text-sm font-medium border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-t ${
                activeTab === tab.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab panels */}
      {activeTab === 'connection' && <ConnectionTab storeId={storeId} />}
      {activeTab === 'templates' && <TemplatesTab storeId={storeId} />}
      {activeTab === 'order-updates' && <OrderUpdatesTab storeId={storeId} />}
      {activeTab === 'payment-link' && <PaymentLinkTab storeId={storeId} />}
      {activeTab === 'bot-copy' && <BotCopyTab storeId={storeId} />}
      {activeTab === 'bot-analytics' && <BotAnalyticsTab storeId={storeId} />}
    </AdminLayout>
  );
}
