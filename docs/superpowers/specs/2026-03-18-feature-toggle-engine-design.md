# Phase 0: Feature Toggle Engine — Design Spec

## Overview

A per-store feature flag system controlled exclusively by super_admin. Every new store starts with all toggleable features OFF. Super admin manually enables features per store via the admin dashboard. Disabled features are completely hidden from both storefront and admin UI, and blocked at the API level.

## Decisions

- **Access model:** Fully manual per store (no plan-based defaults)
- **Disabled behavior:** Hidden completely (no "locked" upsell state)
- **Core features:** Products, Categories, Orders, Checkout, Auth, Store Settings, Branding, Basic Analytics are always on
- **Admin UI:** New "Features" tab on existing `/stores/[id]` page (super_admin only)
- **Multi-tenant:** Every feature flag is scoped to a storeId. Store admins cannot see or modify feature flags.

## Data Layer

### New Prisma Model: `StoreFeature`

```prisma
model StoreFeature {
  id         String   @id @default(uuid())
  storeId    String   @map("store_id")
  featureKey String   @map("feature_key")
  enabled    Boolean  @default(false)
  enabledAt  DateTime? @map("enabled_at")
  enabledBy  String?  @map("enabled_by")
  updatedAt  DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)
  user  User? @relation(fields: [enabledBy], references: [id], onDelete: SetNull)

  @@unique([storeId, featureKey])
  @@index([storeId])
  @@map("store_features")
}
```

### Migration

- Add `StoreFeature` model
- Add relation fields on `Store` and `User` models
- **Data migration for existing boolean flags:** The Store model already has `taxEnabled`, `loyaltyEnabled`, and `pwaEnabled` columns. Migration must:
  1. For each existing store, create `StoreFeature` rows from these booleans (e.g., if `store.loyaltyEnabled === true`, insert `{ storeId, featureKey: 'loyalty', enabled: true }`)
  2. After migration is verified, remove `taxEnabled`, `loyaltyEnabled`, `pwaEnabled` columns from Store model
  3. Update all services that read these columns to use `featureService.isFeatureEnabled()` instead
- New stores with no StoreFeature rows = all features OFF

## Feature Registry

Single source of truth in `@force/shared`:

```typescript
// packages/shared/src/features.ts

export type FeatureKey =
  | 'coupons'
  | 'loyalty'
  | 'returns'
  | 'reviews'
  | 'inventory'
  | 'tax'
  | 'bulk_operations'
  | 'customer_wallet'
  | 'upsell_crosssell'
  | 'whatsapp'
  | 'sms'
  | 'push_notifications'
  | 'email_campaigns'
  | 'abandoned_cart'
  | 'affiliate'
  | 'marketing_pixels'
  | 'shipping_carriers'
  | 'staff_accounts'
  | 'pwa'
  | 'seo'
  | 'search_autocomplete';

export type FeatureCategory = 'commerce' | 'marketing' | 'operations' | 'storefront';

export interface FeatureDefinition {
  key: FeatureKey;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  category: FeatureCategory;
}

export const FEATURE_REGISTRY: Record<FeatureKey, FeatureDefinition> = {
  // Commerce
  coupons: {
    key: 'coupons',
    name: 'Coupons & Discounts',
    nameAr: 'الكوبونات والخصومات',
    description: 'Create discount codes and promotional offers',
    descriptionAr: 'إنشاء أكواد خصم وعروض ترويجية',
    category: 'commerce',
  },
  loyalty: {
    key: 'loyalty',
    name: 'Loyalty Program',
    nameAr: 'برنامج الولاء',
    description: 'Points system with tiers and rewards',
    descriptionAr: 'نظام نقاط مع مستويات ومكافآت',
    category: 'commerce',
  },
  returns: {
    key: 'returns',
    name: 'Returns & Exchanges',
    nameAr: 'المرتجعات والاستبدال',
    description: 'Customer return requests and refund management',
    descriptionAr: 'طلبات إرجاع العملاء وإدارة الاسترداد',
    category: 'commerce',
  },
  reviews: {
    key: 'reviews',
    name: 'Product Reviews',
    nameAr: 'تقييمات المنتجات',
    description: 'Customer ratings and review moderation',
    descriptionAr: 'تقييمات العملاء وإدارة المراجعات',
    category: 'commerce',
  },
  inventory: {
    key: 'inventory',
    name: 'Inventory Management',
    nameAr: 'إدارة المخزون',
    description: 'Stock tracking, alerts, and audit trail',
    descriptionAr: 'تتبع المخزون والتنبيهات وسجل التدقيق',
    category: 'commerce',
  },
  tax: {
    key: 'tax',
    name: 'Tax Configuration',
    nameAr: 'إعدادات الضرائب',
    description: 'Multi-rate tax rules and calculations',
    descriptionAr: 'قواعد ضريبية متعددة المعدلات والحسابات',
    category: 'commerce',
  },
  bulk_operations: {
    key: 'bulk_operations',
    name: 'Bulk Operations',
    nameAr: 'العمليات المجمعة',
    description: 'CSV import/export and batch product updates',
    descriptionAr: 'استيراد/تصدير CSV وتحديثات المنتجات المجمعة',
    category: 'commerce',
  },
  customer_wallet: {
    key: 'customer_wallet',
    name: 'Customer Wallet',
    nameAr: 'محفظة العميل',
    description: 'Store credit and wallet balance management',
    descriptionAr: 'رصيد المتجر وإدارة المحفظة',
    category: 'commerce',
  },
  upsell_crosssell: {
    key: 'upsell_crosssell',
    name: 'Upsell & Cross-sell',
    nameAr: 'البيع التكميلي والبيع المتقاطع',
    description: 'Product recommendations and "frequently bought together"',
    descriptionAr: 'توصيات المنتجات و"يتم شراؤها معًا بشكل متكرر"',
    category: 'commerce',
  },

  // Marketing
  whatsapp: {
    key: 'whatsapp',
    name: 'WhatsApp Notifications',
    nameAr: 'إشعارات واتساب',
    description: 'Order updates and marketing via WhatsApp Business API',
    descriptionAr: 'تحديثات الطلبات والتسويق عبر واتساب بزنس',
    category: 'marketing',
  },
  sms: {
    key: 'sms',
    name: 'SMS Notifications',
    nameAr: 'إشعارات الرسائل النصية',
    description: 'Order updates and marketing via SMS',
    descriptionAr: 'تحديثات الطلبات والتسويق عبر الرسائل النصية',
    category: 'marketing',
  },
  push_notifications: {
    key: 'push_notifications',
    name: 'Push Notifications',
    nameAr: 'الإشعارات الفورية',
    description: 'Browser and mobile push notifications',
    descriptionAr: 'إشعارات المتصفح والجوال',
    category: 'marketing',
  },
  email_campaigns: {
    key: 'email_campaigns',
    name: 'Email Campaigns',
    nameAr: 'حملات البريد الإلكتروني',
    description: 'Bulk email marketing and automation',
    descriptionAr: 'التسويق عبر البريد الإلكتروني والأتمتة',
    category: 'marketing',
  },
  abandoned_cart: {
    key: 'abandoned_cart',
    name: 'Abandoned Cart Recovery',
    nameAr: 'استرداد السلة المتروكة',
    description: 'Automated reminders for abandoned shopping carts',
    descriptionAr: 'تذكيرات تلقائية لسلات التسوق المتروكة',
    category: 'marketing',
  },
  affiliate: {
    key: 'affiliate',
    name: 'Affiliate Program',
    nameAr: 'برنامج الإحالة',
    description: 'Referral commissions for influencers and partners',
    descriptionAr: 'عمولات الإحالة للمؤثرين والشركاء',
    category: 'marketing',
  },
  marketing_pixels: {
    key: 'marketing_pixels',
    name: 'Marketing Pixels',
    nameAr: 'بكسلات التسويق',
    description: 'Facebook, TikTok, Snapchat, Google tracking pixels',
    descriptionAr: 'بكسلات تتبع فيسبوك وتيك توك وسناب شات وجوجل',
    category: 'marketing',
  },

  // Operations
  shipping_carriers: {
    key: 'shipping_carriers',
    name: 'Shipping Carrier Integrations',
    nameAr: 'ربط شركات الشحن',
    description: 'Direct API integration with delivery companies',
    descriptionAr: 'ربط مباشر مع شركات التوصيل عبر API',
    category: 'operations',
  },
  staff_accounts: {
    key: 'staff_accounts',
    name: 'Staff Sub-Accounts',
    nameAr: 'حسابات الموظفين',
    description: 'Multiple staff users with granular permissions',
    descriptionAr: 'مستخدمين متعددين للموظفين مع صلاحيات دقيقة',
    category: 'operations',
  },

  // Storefront
  pwa: {
    key: 'pwa',
    name: 'Progressive Web App',
    nameAr: 'تطبيق ويب تقدمي',
    description: 'Installable app experience with offline support',
    descriptionAr: 'تجربة تطبيق قابل للتثبيت مع دعم عدم الاتصال',
    category: 'storefront',
  },
  seo: {
    key: 'seo',
    name: 'SEO Settings',
    nameAr: 'إعدادات تحسين محركات البحث',
    description: 'Meta tags, OG images, JSON-LD, sitemap configuration',
    descriptionAr: 'وسوم Meta وصور OG وJSON-LD وإعدادات خريطة الموقع',
    category: 'storefront',
  },
  search_autocomplete: {
    key: 'search_autocomplete',
    name: 'Search Autocomplete',
    nameAr: 'الإكمال التلقائي للبحث',
    description: 'Real-time search suggestions as customers type',
    descriptionAr: 'اقتراحات بحث فورية أثناء كتابة العملاء',
    category: 'storefront',
  },
};

export const FEATURE_KEYS = Object.keys(FEATURE_REGISTRY) as FeatureKey[];

export const FEATURE_CATEGORIES: Record<FeatureCategory, string> = {
  commerce: 'Commerce',
  marketing: 'Marketing',
  operations: 'Operations',
  storefront: 'Storefront',
};

export const FEATURE_CATEGORIES_AR: Record<FeatureCategory, string> = {
  commerce: 'التجارة',
  marketing: 'التسويق',
  operations: 'العمليات',
  storefront: 'واجهة المتجر',
};
```

## API Layer

### New Service: `feature.service.ts`

```
getStoreFeatures(storeId: string): Promise<Record<FeatureKey, boolean>>
  - Check Redis cache first (`features:store:{storeId}`)
  - Cache miss → query StoreFeature table for all rows where storeId matches
  - Build a map of featureKey → enabled (default false for missing keys)
  - Cache in Redis with 5min TTL
  - Return full map

isFeatureEnabled(storeId: string, featureKey: FeatureKey): Promise<boolean>
  - Calls getStoreFeatures() (cached) and checks the key

updateStoreFeatures(storeId: string, updates: Partial<Record<FeatureKey, boolean>>, userId: string): Promise<void>
  - Validate all keys against FEATURE_KEYS using Zod enum (reject unknown keys)
  - Upsert StoreFeature rows for each key in updates
  - Set enabledAt = now() when enabling, null when disabling
  - Set enabledBy = userId
  - After DB write, SET Redis cache with the full computed map (not DELETE-then-repopulate, to avoid stale reads from Neon replicas)
  - Log to audit trail

setFeature(storeId: string, featureKey: FeatureKey, enabled: boolean, userId: string): Promise<boolean>
  - Explicit set (not toggle) — idempotent, safe for concurrent calls
  - Validates featureKey against FEATURE_KEYS
  - Returns new state
  - SET Redis cache with full computed map
```

### New Middleware: `requireFeature`

```typescript
// apps/api/src/middleware/feature-gate.ts
export function requireFeature(featureKey: FeatureKey) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const storeId = req.params.storeId || req.params.id || req.store?.id;

    // FAIL CLOSED: if we can't determine the store, block access
    if (!storeId) {
      return res.status(403).json({
        success: false,
        error: 'Feature not available',
        code: 'FEATURE_DISABLED',
        feature: featureKey,
      });
    }

    const enabled = await featureService.isFeatureEnabled(storeId, featureKey);
    if (!enabled) {
      return res.status(403).json({
        success: false,
        error: 'Feature not available',
        code: 'FEATURE_DISABLED',
        feature: featureKey,
      });
    }
    next();
  };
}
```

**Security note:** The middleware fails closed — if storeId cannot be determined, access is denied. This prevents bypass via routes that resolve storeId from headers or session rather than URL params.

### New Routes: Feature Management (super_admin only)

```
GET  /admin/stores/:id/features
  → authenticate → authorize('super_admin') → getStoreFeatures handler

PUT  /admin/stores/:id/features
  → authenticate → authorize('super_admin') → updateStoreFeatures handler
  Body: { coupons: true, loyalty: false, whatsapp: true }

PUT  /admin/stores/:id/features/:featureKey
  → authenticate → authorize('super_admin') → setFeature handler
  Body: { enabled: true } (explicit, idempotent — no toggle)
```

### Public Features Endpoint

Instead of a standalone `/features` endpoint (which enables reconnaissance), embed features in the existing public store endpoint:

```
GET /public/stores/:slugOrId
  → existing response + { enabledFeatures: ['coupons', 'returns', 'reviews', ...] }
  (only enabled feature key names, no toggle metadata or timestamps)
```

The store resolver already fetches store data — adding the enabled features list here avoids an extra request and doesn't expose a new enumeration surface.

### Applying to Existing Routes

Add `requireFeature()` to every toggleable route group:

```
// Coupon routes
router.use(requireFeature('coupons'));

// Loyalty routes
router.use(requireFeature('loyalty'));

// Returns routes
router.use(requireFeature('returns'));

// Reviews routes
router.use(requireFeature('reviews'));

// Inventory routes
router.use(requireFeature('inventory'));

// Tax routes
router.use(requireFeature('tax'));

// Bulk operations routes
router.use(requireFeature('bulk_operations'));

// PWA routes
router.use(requireFeature('pwa'));

// SEO routes
router.use(requireFeature('seo'));

// Marketing pixels routes
router.use(requireFeature('marketing_pixels'));

// Review routes (review.routes.ts)
router.use(requireFeature('reviews'));

// Return routes (return.routes.ts)
router.use(requireFeature('returns'));

// Loyalty routes (loyalty.routes.ts)
router.use(requireFeature('loyalty'));
```

**Order creation gating:** The public order creation endpoint (`POST /public/orders`) accepts a `couponCode` field. When `coupons` feature is disabled, the order handler must ignore the coupon field (strip it before processing) rather than blocking the entire order. Similarly, loyalty point redemption in checkout must be skipped when `loyalty` is disabled. This is handled inside the order service, not via route-level middleware.

## Admin UI

### Features Tab on Store Detail Page

Location: `/apps/admin/src/app/stores/[id]/page.tsx`

Add a "Features" tab alongside existing Overview tab.

**Layout:**

- Grouped by category (Commerce, Marketing, Operations, Storefront)
- Each feature: name + description + toggle switch
- "Save Changes" button at bottom
- Shows last modified timestamp per feature
- Bilingual labels (EN/AR ready)

**Data flow:**

1. On mount: `GET /admin/stores/:id/features`
2. Display toggles with current state
3. On toggle change: track dirty state locally
4. On save: `PUT /admin/stores/:id/features` with changed features only
5. Success toast, refresh state

### Store Admin Sidebar Gating

Location: `/apps/admin/src/components/AdminLayout.tsx`

The sidebar menu items for store-level features must be conditionally rendered:

```tsx
const { isEnabled } = useFeatures();

// In sidebar navigation
{
  isEnabled('coupons') && <NavLink href={`/stores/${storeId}/coupons`}>Coupons</NavLink>;
}
{
  isEnabled('loyalty') && <NavLink href={`/stores/${storeId}/loyalty`}>Loyalty</NavLink>;
}
// ... etc for all toggleable features
```

### Store Admin Settings Hub Gating

Location: `/apps/admin/src/app/stores/[id]/settings/page.tsx`

Same pattern — settings cards are conditionally rendered.

## Web Storefront

### Feature Context

Since features are now embedded in the store data response (`GET /public/stores/:slugOrId`), and the StoreContext already fetches store data, features are available without an extra request:

```typescript
// apps/web/src/contexts/FeatureContext.tsx
// Features are derived from StoreContext — no separate fetch needed.
// StoreContext already fetches store data server-side (in layout.tsx),
// so features are available on first render with no flash.

const FeatureContext = createContext<{
  features: Set<string>;
  isEnabled: (key: FeatureKey) => boolean;
}>({ features: new Set(), isEnabled: () => false });

export function FeatureProvider({ children, enabledFeatures }: {
  children: React.ReactNode;
  enabledFeatures: string[];
}) {
  const features = useMemo(() => new Set(enabledFeatures), [enabledFeatures]);
  const isEnabled = useCallback((key: FeatureKey) => features.has(key), [features]);

  return (
    <FeatureContext.Provider value={{ features, isEnabled }}>
      {children}
    </FeatureContext.Provider>
  );
}

export const useFeatures = () => useContext(FeatureContext);
```

**No flash:** Features come from the same server-side store fetch that already happens in `layout.tsx`. The `enabledFeatures` array is passed as a prop from the store data, so it's available on first render.

### Storefront Gating Points

- **Header:** Hide wishlist link if reviews disabled, etc.
- **Product detail:** Hide review section if `reviews` disabled
- **Product detail:** Hide upsell section if `upsell_crosssell` disabled
- **Cart:** Hide coupon input if `coupons` disabled
- **Account sidebar:** Hide loyalty, returns links based on flags
- **Footer:** Hide newsletter if `email_campaigns` disabled
- **Search:** Hide autocomplete dropdown if `search_autocomplete` disabled
- **MarketingPixels component:** Skip rendering if `marketing_pixels` disabled
- **PWA manifest/service worker:** Skip if `pwa` disabled

## Cache Strategy

```
Write: super_admin updates features
  → DB upsert StoreFeature rows
  → Re-read all features for this store from PRIMARY (not replica)
  → SET Redis key `features:store:{storeId}` with full computed map + 5min TTL
  (SET, not DELETE — avoids stale read from Neon replica on repopulation)

Read: requireFeature() middleware OR store data endpoint
  → GET Redis key `features:store:{storeId}`
  → Miss? → SELECT * FROM store_features WHERE store_id = ?
  → Build map: { coupons: true, loyalty: false, ... }
  → SET Redis with 5min TTL
  → Return

Invalidation: SET on write (immediate) + 5min TTL as safety net
```

## Error Handling

- API returns `403 { success: false, code: 'FEATURE_DISABLED', feature: '<key>' }`
- Frontend `useFeatures()` defaults to empty set on fetch failure (all hidden)
- Unknown feature keys in registry are ignored (forward-compatible)
- `requireFeature()` with no store context (no storeId) passes through (for non-store routes)

## Testing

- Unit tests for `feature.service.ts` (getStoreFeatures, isFeatureEnabled, updateStoreFeatures)
- Integration test: toggle feature ON → access route → 200; toggle OFF → 403
- Test cache invalidation: toggle → immediate read reflects new state
- Test new store: no StoreFeature rows → all features return false
- Test public endpoint only returns enabled keys

## Files to Create/Modify

**New files:**

- `packages/shared/src/features.ts` — Feature registry
- `apps/api/src/services/feature.service.ts` — Feature service
- `apps/api/src/middleware/feature-gate.ts` — requireFeature middleware
- `apps/api/src/routes/feature.routes.ts` — Admin feature management routes
- `apps/web/src/contexts/FeatureContext.tsx` — Storefront feature context
- `apps/admin/src/hooks/useFeatures.ts` — Admin feature hook

**Modified files:**

- `packages/database/prisma/schema.prisma` — Add StoreFeature model
- `apps/api/src/routes/` — Add requireFeature() to all toggleable route groups
- `apps/admin/src/app/stores/[id]/page.tsx` — Add Features tab
- `apps/admin/src/components/AdminLayout.tsx` — Gate sidebar links
- `apps/admin/src/app/stores/[id]/settings/page.tsx` — Gate settings cards
- `apps/web/src/app/layout.tsx` — Add FeatureProvider
- `apps/web/src/components/Header.tsx` — Gate feature-dependent links
- `apps/web/src/app/products/[slug]/ProductDetailClient.tsx` — Gate reviews section
- `apps/web/src/app/cart/CartClient.tsx` — Gate coupon input
- `apps/web/src/app/account/` — Gate loyalty, returns, addresses links
- `apps/web/src/components/MarketingPixels.tsx` — Gate pixel rendering
