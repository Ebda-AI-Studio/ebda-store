/**
 * THE capability registry: what the marketing site may claim, and whether it is live. Truth-at-merge rule:
 * these features merge in separate PRs, and this site must never say a thing is available before it is.
 * A `coming` item renders "coming soon / قريبًا" everywhere (home, /features, /compare, llms.txt,
 * llms-full.txt) and its comparison rows move to the "not there yet" table. When its PR merges, flip
 * `status` to 'live' and `dependsOn` can stay as the record; tests/unit/marketing-capability-registry.test.ts
 * lists which ids flip with which branch and fails if the two disagree.
 */
export type CapabilityId =
  | 'builder'
  | 'domain'
  | 'ai'
  | 'smartsearch'
  | 'searchwords'
  | 'meaning'
  | 'insights'
  | 'seo'
  | 'assistant'
  | 'cart'
  | 'cartemail'
  | 'emails'
  | 'campaigns'
  | 'webhooks'
  | 'loyalty'
  | 'reviews'
  | 'analytics'
  | 'warehouse'
  | 'barcodes'
  | 'b2b'
  | 'payments'
  | 'commission';

export type CapabilityStatus = 'live' | 'coming';

export interface RegistryEntry {
  status: CapabilityStatus;
  /** For `coming`: the open branch / PR whose merge makes it live. */
  dependsOn?: string;
}

export const REGISTRY: Record<CapabilityId, RegistryEntry> = {
  builder: { status: 'live' },
  domain: { status: 'live' },
  ai: { status: 'live' },
  smartsearch: { status: 'live' },
  searchwords: { status: 'live' },
  // Search PR4. Stays off per store until the real catalogue passes the quality test.
  meaning: { status: 'coming', dependsOn: 'feat/search-p1c-hybrid (search PR4)' },
  insights: { status: 'live' },
  seo: { status: 'live' },
  assistant: { status: 'live' },
  cart: { status: 'live' },
  cartemail: { status: 'live' },
  emails: { status: 'live' },
  campaigns: { status: 'live' },
  webhooks: { status: 'coming', dependsOn: 'feat/merchant-webhooks' },
  loyalty: { status: 'live' },
  reviews: { status: 'live' },
  analytics: { status: 'live' },
  warehouse: { status: 'live' },
  barcodes: { status: 'live' },
  b2b: { status: 'coming', dependsOn: 'feat/b2b-wholesale' },
  payments: { status: 'live' },
  commission: { status: 'live' },
};

export const isLive = (id: CapabilityId) => REGISTRY[id].status === 'live';

/** Words shown on a coming item. */
export const COMING_LABEL = { ar: 'قريبًا', en: 'Coming soon' } as const;
