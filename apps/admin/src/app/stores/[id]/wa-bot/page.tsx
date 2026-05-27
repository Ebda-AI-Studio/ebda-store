'use client';

/**
 * /stores/[id]/wa-bot — WhatsApp Bot Configuration page.
 *
 * Three cards (Phase D):
 *   1. BotModeCard     — legacy_chat / native_catalog / native_catalog_with_gemini_agent
 *   2. ServiceMenuCard — 4 service menu toggles + optional EN/AR label overrides
 *   3. MetaCatalogCard — Meta catalog ID + business ID + access token (write-only)
 *
 * Data loaded once on mount from GET /api/v1/stores/:id/integrations/wbs.
 * Each card handles its own save independently.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet } from '../../../../lib/api';
import { BotModeCard } from './BotModeCard';
import { ServiceMenuCard } from './ServiceMenuCard';
import { MetaCatalogCard } from './MetaCatalogCard';
import type { BotMode, BotServiceMenu, MetaCatalogConfig } from '../../../../lib/types/wa-bot';
import { DEFAULT_SERVICE_MENU } from '../../../../lib/types/wa-bot';

// ─── Shape of the wbs-integration GET response ────────────────────────────────

interface WbsBotConfig {
  botMode: BotMode;
  botServiceMenu: BotServiceMenu | null;
  metaCatalogId: string | null;
  metaBusinessId: string | null;
  hasMetaToken: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function WaBotPage() {
  const params = useParams<{ id: string }>();
  const storeId = params.id;

  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<WbsBotConfig | null>(null);

  const fetchConfig = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    const { data } = await apiGet<WbsBotConfig>(`/api/v1/stores/${storeId}/integrations/wbs`);
    if (data) setConfig(data);
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const serviceMenu: BotServiceMenu = config?.botServiceMenu ?? DEFAULT_SERVICE_MENU;

  const metaConfig: MetaCatalogConfig = {
    metaCatalogId: config?.metaCatalogId ?? null,
    metaBusinessId: config?.metaBusinessId ?? null,
    hasMetaToken: config?.hasMetaToken ?? false,
  };

  return (
    <AdminLayout
      title="WhatsApp Bot Config"
      subtitle="Bot mode · service menu · Meta Commerce catalog"
    >
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <div className="max-w-2xl space-y-6">
          <BotModeCard storeId={storeId} initialMode={config?.botMode ?? 'legacy_chat'} />
          <ServiceMenuCard storeId={storeId} initialMenu={serviceMenu} />
          <MetaCatalogCard storeId={storeId} initialConfig={metaConfig} />
        </div>
      )}
    </AdminLayout>
  );
}
