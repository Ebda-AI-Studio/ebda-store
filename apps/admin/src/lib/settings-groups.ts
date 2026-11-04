/**
 * The five groups of the Settings hub (UX:SH-1). One list feeds BOTH the hub page's grouped cards and the
 * inline-start rail shown on every settings page (UX:N-3), so the two can never disagree.
 * `card` is the key under `settings.cards` (title + one plain sentence); `path` is the page under /stores/[id].
 */
export interface SettingsGroupItem {
  card: string;
  path: string;
  /** Hidden unless this feature is enabled for the store. */
  featureKey?: string;
}

export interface SettingsGroup {
  key: 'store' | 'sales' | 'visibility' | 'team' | 'developers';
  /** Collapsed by default on the hub page (developer tools are not everyday settings). */
  collapsed?: boolean;
  items: SettingsGroupItem[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    key: 'store',
    items: [
      { card: 'template', path: 'builder' },
      { card: 'branding', path: 'branding' },
      { card: 'language', path: 'language' },
      { card: 'announcement', path: 'announcement' },
      { card: 'categories', path: 'categories' },
    ],
  },
  {
    key: 'sales',
    items: [
      { card: 'paymentSettings', path: 'payment-settings' },
      { card: 'shipping', path: 'shipping' },
      { card: 'checkoutDelivery', path: 'delivery' },
      { card: 'taxSettings', path: 'tax' },
      { card: 'notifications', path: 'notifications' },
    ],
  },
  {
    key: 'visibility',
    items: [
      { card: 'seo', path: 'seo' },
      { card: 'domain', path: 'domain' },
      { card: 'pwaSettings', path: 'pwa' },
      { card: 'qrCodes', path: 'qr' },
    ],
  },
  {
    key: 'team',
    items: [
      { card: 'staff', path: 'staff' },
      { card: 'billing', path: 'billing' },
    ],
  },
  {
    key: 'developers',
    collapsed: true,
    items: [
      { card: 'agentKey', path: 'agent-key', featureKey: 'agent_checkout' },
      { card: 'webhooks', path: 'webhooks' },
      { card: 'merchantKeys', path: 'merchant-keys', featureKey: 'merchant_mcp' },
    ],
  },
];
