'use client';

/**
 * Master WhatsApp Integration page.
 *
 * Consolidates every WhatsApp sub-page into a single tabbed view:
 *   ?tab=connection     — connect WBS API key + template selection
 *   ?tab=bot-config     — bot mode + service menu + Meta Commerce catalog
 *                         (was /wa-bot — merged in 2026-05-28 to remove the
 *                         page-bouncing overlap with this tabset)
 *   ?tab=templates      — generate + sync Meta templates
 *   ?tab=order-updates  — per-event toggle configuration
 *   ?tab=payment-link   — merchant-initiated payment links
 *   ?tab=bot-copy       — per-store bot copy overrides
 *   ?tab=bot-analytics  — per-store bot conversation metrics
 *
 * Old page paths redirect here (thin redirect components).
 */

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { ConnectionTab } from '../../../../components/whatsapp/ConnectionTab';
import { BotConfigTab } from '../../../../components/whatsapp/BotConfigTab';
import { TemplatesTab } from '../../../../components/whatsapp/TemplatesTab';
import { OrderUpdatesTab } from '../../../../components/whatsapp/OrderUpdatesTab';
import { PaymentLinkTab } from '../../../../components/whatsapp/PaymentLinkTab';
import { BotCopyTab } from '../../../../components/whatsapp/BotCopyTab';
import { BotAnalyticsTab } from '../../../../components/whatsapp/BotAnalyticsTab';

// ─── Tab definitions ──────────────────────────────────────────────────────────

type TabKey =
  | 'connection'
  | 'bot-config'
  | 'templates'
  | 'order-updates'
  | 'payment-link'
  | 'bot-copy'
  | 'bot-analytics';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'connection', label: 'Connection' },
  { key: 'bot-config', label: 'Bot Config' },
  { key: 'templates', label: 'Templates' },
  { key: 'order-updates', label: 'Order Updates' },
  { key: 'payment-link', label: 'Payment Link' },
  { key: 'bot-copy', label: 'Bot Copy' },
  { key: 'bot-analytics', label: 'Bot Analytics' },
];

function isValidTab(value: string | null): value is TabKey {
  return (
    value === 'connection' ||
    value === 'bot-config' ||
    value === 'templates' ||
    value === 'order-updates' ||
    value === 'payment-link' ||
    value === 'bot-copy' ||
    value === 'bot-analytics'
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function WhatsAppMasterPage() {
  // Feature gate: whatsapp is an addon feature; absent from PLAN_BASELINE by
  // default and enabled only via super-admin override per store.
  const { gate } = useRequireFeature('whatsapp');

  const params = useParams<{ id: string }>();
  const storeId = params.id;
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawTab = searchParams.get('tab');
  const activeTab: TabKey = isValidTab(rawTab) ? rawTab : 'connection';

  const switchTab = (key: TabKey) => {
    router.replace(`/stores/${storeId}/whatsapp?tab=${key}`);
  };

  // Render gate (upsell page) for store_admin when feature is disabled.
  // Super-admin always passes through so they can configure the feature.
  if (gate) return gate;

  return (
    <AdminLayout
      title="WhatsApp Integration"
      subtitle="Force AI WhatsApp Business Platform · templates · order updates · payment links"
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
      {activeTab === 'bot-config' && <BotConfigTab storeId={storeId} />}
      {activeTab === 'templates' && <TemplatesTab storeId={storeId} />}
      {activeTab === 'order-updates' && <OrderUpdatesTab storeId={storeId} />}
      {activeTab === 'payment-link' && <PaymentLinkTab storeId={storeId} />}
      {activeTab === 'bot-copy' && <BotCopyTab storeId={storeId} />}
      {activeTab === 'bot-analytics' && <BotAnalyticsTab storeId={storeId} />}
    </AdminLayout>
  );
}
