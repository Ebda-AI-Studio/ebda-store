import { composeStoreTheme, getLook, type TemplateId } from '@ebda/shared';

/**
 * The theme a store's brand surfaces OUTSIDE the storefront read (emails, invoices, campaign
 * mail, setup guide). A look store's colours live in the look, not in `stores.theme`, so a raw
 * `theme.primaryColor` read misses them: a look store is composed exactly like the storefront
 * (`composeStoreTheme`, the merchant's stored keys still win, Ruling LOOKS-3). A legacy store
 * (no or unknown look) keeps reading its stored theme as-is, so its emails and invoices stay
 * byte-identical (Ruling LOOKS-14).
 */
export function storeBrandTheme(store: {
  template?: string | null;
  look?: string | null;
  theme?: unknown;
}): Record<string, unknown> | null {
  const stored =
    store.theme && typeof store.theme === 'object'
      ? (store.theme as Record<string, unknown>)
      : null;
  if (!getLook(store.look)) return stored;
  return composeStoreTheme({
    template: (store.template ?? 'modern') as TemplateId,
    look: store.look,
    theme: stored,
  }) as unknown as Record<string, unknown>;
}
