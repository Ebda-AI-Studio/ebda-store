/**
 * Shared types for the WhatsApp Bot Config admin UI (Phase D).
 *
 * These mirror the shapes returned/accepted by:
 *   GET /api/v1/stores/:id/integrations/wbs  (botMode, botServiceMenu, metaCatalog* fields)
 *   PUT /api/v1/stores/:id/integrations/wbs
 *
 * metaAccessToken is NEVER returned to the client — only hasMetaToken is.
 */

export type BotMode = 'legacy_chat' | 'native_catalog' | 'native_catalog_with_gemini_agent';

export type BotServiceMenu = {
  orderNow: boolean;
  subscriptionBoxes: boolean;
  locationsHours: boolean;
  chatWithAgent: boolean;
  labels?: {
    en?: Record<string, string>;
    ar?: Record<string, string>;
  };
};

/**
 * What the admin GET returns for Meta Catalog config.
 * hasMetaToken is true when an encrypted token is stored — the token value
 * is NEVER exposed to the browser.
 */
export type MetaCatalogConfig = {
  metaCatalogId: string | null;
  metaBusinessId: string | null;
  hasMetaToken: boolean;
};

export const DEFAULT_SERVICE_MENU: BotServiceMenu = {
  orderNow: true,
  subscriptionBoxes: false,
  locationsHours: true,
  chatWithAgent: true,
  labels: { en: {}, ar: {} },
};

export const BOT_MODE_LABELS: Record<BotMode, string> = {
  legacy_chat: 'Legacy Chat (text-based ordering)',
  native_catalog: 'Native Catalog (Meta Commerce)',
  native_catalog_with_gemini_agent: 'Native Catalog + Gemini AI Agent',
};
