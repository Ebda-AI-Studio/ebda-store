// Task 1.4: the Store model is split by where each column is READ.
//   d1      the directory row in D1 `stores` only (resolution, domains, billing suspension, email domain).
//   mirror  authoritative in D1 `stores`, copied into the StoreDO `store_profile` by the write-through
//           (a settings change in the DO emits a D1 update for these fields only, through the `d1_outbox`).
//   profile DO-only: branding, content, SEO, contact, pixels, theme.
//   config  DO-only: commerce, flags, integrations, AI and accounting switches (everything else).
// Cloudflare DO SQLite allows 100 columns per table (phase-0 memo, finding 1): Store has 105, so the
// split is column-count driven as well as semantic; the generator and the test both enforce <= 100.

export const STORE_D1_ONLY = [
  'domainStatus',
  'pendingDomain',
  'domainClaimedAt',
  'domainVerifiedAt',
  'domainProvider',
  'emailSenderLocalPart',
  'emailDomainId',
  'emailDomainStatus',
  'emailDomainVerifiedAt',
  'billingSuspendedReason',
  'billingSuspendedAt',
  'deletedAt',
];

export const STORE_MIRROR = [
  'id',
  'name',
  'nameAr',
  'slug',
  'domain',
  'ownerId',
  'status',
  'plan',
  'currency',
  'timezone',
  'template',
  'look',
  'isDemo',
  'logo',
  'logoAr',
  'favicon',
  'createdAt',
  'updatedAt',
];

export const STORE_PROFILE = [
  'heroTitle',
  'heroTitleAr',
  'heroSubtitle',
  'heroSubtitleAr',
  'heroCtaText',
  'heroCtaTextAr',
  'heroCtaLink',
  'heroImage',
  'bestSellersImage',
  'typography',
  'description',
  'descriptionAr',
  'theme',
  'layoutSettings',
  'socialLinks',
  'email',
  'phone',
  'phoneAr',
  'whatsapp',
  'address',
  'addressAr',
  'businessHours',
  'googleMapsUrl',
  'announcementBar',
  'metaTitle',
  'metaTitleAr',
  'metaDescription',
  'metaDescriptionAr',
  'metaDescriptionAeo',
  'metaDescriptionAeoAr',
  'ogImage',
  'twitterHandle',
  'googleSiteVerification',
  'marketingPixels',
  'metaPixelId',
  'tiktokPixelId',
  'snapchatPixelId',
  'googleAnalyticsId',
  'googleTagManagerId',
  'googleAdsId',
  'twitterPixelId',
  'pinterestTagId',
  'llmsTxt',
  'aboutJson',
];

// Every other Store scalar is `config`. The generator computes it so a new Prisma column lands in
// `config` (DO) by default and the test then forces a conscious decision when it should go elsewhere.
export function classifyStoreColumns(scalarFieldNames) {
  const d1 = new Set(STORE_D1_ONLY);
  const mirror = new Set(STORE_MIRROR);
  const profile = new Set(STORE_PROFILE);
  const out = { d1Only: [], mirror: [], profile: [], config: [] };
  const seen = new Set();
  for (const n of scalarFieldNames) {
    const buckets = [
      d1.has(n) && 'd1Only',
      mirror.has(n) && 'mirror',
      profile.has(n) && 'profile',
    ].filter(Boolean);
    if (buckets.length > 1)
      throw new Error(`Store.${n} is assigned to more than one bucket: ${buckets.join(', ')}`);
    out[buckets[0] ?? 'config'].push(n);
    seen.add(n);
  }
  for (const n of [...d1, ...mirror, ...profile]) {
    if (!seen.has(n)) throw new Error(`store-split names a column that is not on Store: ${n}`);
  }
  return out;
}
