/**
 * THE capability registry: what the marketing site may claim, and whether it is live. Truth-at-merge rule:
 * these features merge in separate PRs, and this site must never say a thing is available before it is.
 * A `coming` item renders "coming soon / قريبًا" everywhere (home, /features, /compare, llms.txt,
 * llms-full.txt) and its comparison rows move to the "not there yet" table. When its PR merges, flip
 * `status` to 'live' and `dependsOn` can stay as the record; tests/unit/marketing-capability-registry.test.ts
 * lists which ids flip with which branch and fails if the two disagree.
 */
/** A capability that renders as one card on /features. One card per capability, never two for the same thing. */
export type CardId =
  | 'ai'
  | 'search'
  | 'assistant'
  | 'accounting'
  | 'inventory'
  | 'analytics'
  | 'instapay'
  | 'seo'
  | 'builder'
  | 'domain'
  | 'cart'
  | 'emails'
  | 'campaigns'
  | 'loyalty'
  | 'reviews'
  | 'payments'
  | 'warehouse'
  | 'barcodes'
  | 'b2b'
  | 'webhooks'
  | 'commission';

/** A status flag with no card of its own. None today (the "search by meaning" flag was removed 2026-11-11: public copy states only what exists). */
export type FlagId = never;

export type CapabilityId = CardId | FlagId;

export type CapabilityStatus = 'live' | 'coming';

export interface RegistryEntry {
  status: CapabilityStatus;
  /** For `coming`: the open branch / PR whose merge makes it live. */
  dependsOn?: string;
  /** Tagged `ai`: it must appear in the AI theme of /features, exactly once. */
  ai?: true;
}

export const REGISTRY: Record<CapabilityId, RegistryEntry> = {
  ai: { status: 'live', ai: true },
  search: { status: 'live', ai: true },
  assistant: { status: 'live', ai: true },
  accounting: { status: 'live', ai: true },
  inventory: { status: 'live', ai: true },
  analytics: { status: 'live', ai: true },
  instapay: { status: 'live', ai: true },
  seo: { status: 'live', ai: true },
  builder: { status: 'live' },
  domain: { status: 'live' },
  cart: { status: 'live' },
  emails: { status: 'live' },
  campaigns: { status: 'live' },
  loyalty: { status: 'live' },
  reviews: { status: 'live' },
  payments: { status: 'live' },
  warehouse: { status: 'live' },
  barcodes: { status: 'live' },
  b2b: { status: 'live' },
  webhooks: { status: 'live' },
  commission: { status: 'live' },
};

export type ThemeId = 'ai' | 'store' | 'sell' | 'ops' | 'pricing';

/** The /features layout: themes in page order, the cards in each, each capability exactly once. */
export const THEMES: readonly { id: ThemeId; ids: readonly CardId[] }[] = [
  {
    id: 'ai',
    ids: ['ai', 'search', 'assistant', 'accounting', 'inventory', 'analytics', 'instapay', 'seo'],
  },
  { id: 'store', ids: ['builder', 'domain'] },
  { id: 'sell', ids: ['cart', 'emails', 'campaigns', 'loyalty', 'reviews'] },
  { id: 'ops', ids: ['payments', 'warehouse', 'barcodes', 'b2b', 'webhooks'] },
  { id: 'pricing', ids: ['commission'] },
];

export const isLive = (id: CapabilityId) => REGISTRY[id].status === 'live';

/** Words shown on a coming item. */
export const COMING_LABEL = { ar: 'قريبًا', en: 'Coming soon' } as const;
