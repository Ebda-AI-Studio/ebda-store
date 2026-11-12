/**
 * The merchant's switch for AUTOMATIC product recommendations (bought-together, similar items, AI picks):
 * `stores.settings.autoRecommendationsEnabled`, absent = ON. Off = merchant-curated picks only.
 * Server-owned key (packages/shared/src/server-owned-settings.ts): written only by
 * `PUT /stores/:id/recommendations/auto-setting`, so a stale whole-settings PUT cannot flip it.
 */
export const AUTO_RECOMMENDATIONS_SETTING = 'autoRecommendationsEnabled';

export function autoRecommendationsEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;
  return (settings as Record<string, unknown>)[AUTO_RECOMMENDATIONS_SETTING] !== false;
}
