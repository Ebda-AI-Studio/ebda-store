'use client';

/**
 * BotConfigTab — merged from the standalone /wa-bot page into the
 * master /whatsapp tab set so merchants don't bounce between two pages
 * that both configure the same WhatsApp surface.
 *
 * Wraps three existing cards (BotMode + ServiceMenu + MetaCatalog),
 * shares the same GET /api/v1/stores/:id/integrations/wbs fetch the
 * old /wa-bot page used. Each card still handles its own PUT save.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../lib/api';
import { BotModeCard } from '../../app/stores/[id]/wa-bot/BotModeCard';
import { ServiceMenuCard } from '../../app/stores/[id]/wa-bot/ServiceMenuCard';
import { MetaCatalogCard } from '../../app/stores/[id]/wa-bot/MetaCatalogCard';
import type { BotMode, BotServiceMenu, MetaCatalogConfig } from '../../lib/types/wa-bot';
import { DEFAULT_SERVICE_MENU } from '../../lib/types/wa-bot';

interface WbsBotConfig {
  botMode: BotMode;
  botServiceMenu: BotServiceMenu | null;
  metaCatalogId: string | null;
  metaBusinessId: string | null;
  hasMetaToken: boolean;
}

interface Props {
  storeId: string;
}

export function BotConfigTab({ storeId }: Props) {
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <BotModeCard storeId={storeId} initialMode={config?.botMode ?? 'legacy_chat'} />
      <ServiceMenuCard storeId={storeId} initialMenu={serviceMenu} />
      <MetaCatalogCard storeId={storeId} initialConfig={metaConfig} />
    </div>
  );
}
