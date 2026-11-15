/**
 * Phase E5 (plan 4): storefront, store-presentation and AI-job tools. Every write is a `change()` from ./kit that calls the SAME service the admin
 * route calls; the gate of each is that route's own `authorize('store_admin', ...)` (+ `requireFeature`). Reads are `free` tools behind the same role.
 *
 * Deliberately NOT here (see the report of this change):
 *   - store.typography: `GET /stores/:id/typography` is read-only on purpose (Ruling TYPO-WRITER-1: the builder publish is the only writer), and a read
 *     tool on a `preview` capability would be looser than the registry;
 *   - storefront.testimonials-trust: the section lives in the layout document (store-layout.routes.ts PUT, inline) owned by the visual builder;
 *   - storefront.contact-enquiry: `POST /public/contact/enquiry` is the studio's own form, nothing is stored per store (contact-enquiry-public.routes.ts);
 *   - the agent key (store.agent-feed): minting returns a one-time secret (agent-credential.routes.ts), so only the llms.txt job is offered.
 */
import { z } from 'zod/v3';
import type { ToolSpec, TurnCtx } from '@ebda/shared/smart-layer';
import {
  qrSettingsSchema,
  HEX_COLOR,
  QR_FINDERS,
  QR_FRAMES,
  QR_STYLES,
} from '@ebda/shared/qr/schema';
import { locationInputSchema } from '@ebda/shared';
import { storeDb } from '../../lib/repo-factory';
import { readInStoreContext } from '../../lib/store-scoped-read';
import {
  assertStoreAiEnabled,
  isStoreAiEnabled,
  setStoreAiEnabled,
} from '../../lib/store-ai-switch';
import { hasPermission, type Role } from '../../middleware/rbac';
import { featureService } from '../../services/feature.service';
import { LocationsService } from '../../services/locations.service';
import { PagesService } from '../../services/pages.service';
import { PWAService } from '../../services/pwa.service';
import { readQrSettings } from '../../services/qr.service';
import { deleteSlugRedirect, listSlugRedirects } from '../../services/slug-redirect.service';
import { StoreService } from '../../services/store.service';
import {
  BulkAiEnqueueError,
  enqueueBulkAiJob,
  type BulkAiJobSpec,
} from '../../services/bulk-ai-job.service';
import {
  fallbackDnsRecords,
  parseCustomDomain,
  readStoreDomainState,
  setStoreDomain,
} from '../../services/store-domain.service';
import { change, diffRows, f, pair, pick, row, shape } from './kit';
import { fld, readStoreRow, txt } from './store-settings.tools';

type Rec = Record<string, unknown>;
const ROLES = ['store_admin'] as const; // the routes' `authorize('store_admin', 'super_admin')`; a super admin never acts through the assistant
/** A sweep the assistant starts is bounded: a bigger catalogue is run from the AI tools screen (the job itself is catalogue-wide and cannot be cut to a subset). */
const MAX_JOB_PRODUCTS = 50;

// ---- free reads ------------------------------------------------------------------------------------------------------------------------------
const noArgs = z.object({}).strict();
const noArgsSchema = { type: 'object', properties: {}, required: [], additionalProperties: false };
function freeRead(d: {
  name: string;
  capabilityId: string;
  description: string;
  /** The route's gate: `store_admin` only (pages), or any role holding `store:settings` (feature switches). */
  needs: 'store_admin' | 'store:settings';
  read: (ctx: TurnCtx) => Promise<unknown>;
}): ToolSpec {
  return {
    name: d.name,
    capabilityId: d.capabilityId,
    description: d.description,
    policy: 'free',
    undo: 'none',
    resultTrust: 'store-data',
    args: noArgs,
    jsonSchema: noArgsSchema,
    read: async (ctx: TurnCtx) => {
      const ok =
        d.needs === 'store_admin'
          ? ctx.role === 'store_admin'
          : hasPermission(ctx.role as Role, d.needs);
      if (!ok) throw new Error(`forbidden: ${d.name}`);
      return readInStoreContext(ctx.storeId, () => d.read(ctx));
    },
  } as unknown as ToolSpec;
}

const MAX_ITEMS = 10;
const pagesList = freeRead({
  name: 'pages_list',
  capabilityId: 'store.pages-list',
  needs: 'store_admin',
  description:
    "List the store's pages (About us, Contact, Shipping policy, custom pages): slug, title and whether each is published. Use for 'where is my About page', 'which pages do I have', 'فين صفحة من نحن', 'ايه الصفحات اللي عندي'.",
  read: async ctx => {
    const pages = await PagesService.list(ctx.storeId);
    return {
      total: pages.length,
      pages: pages.slice(0, MAX_ITEMS).map(p => ({
        slug: p.slug,
        title: p.title,
        titleAr: p.titleAr,
        isPublished: p.isPublished,
      })),
    };
  },
});

const FLAG_SELECT = {
  loyaltyEnabled: true,
  blogEnabled: true,
  locationsEnabled: true,
  pwaEnabled: true,
} as const;
const shopperFeaturesStatus = freeRead({
  name: 'shopper_features_status',
  capabilityId: 'storefront.shopper-features',
  needs: 'store:settings',
  description:
    "Which shopper-facing features are switched on in this store: reviews, coupons, search suggestions, upsell, abandoned-cart recovery, push notifications, the installable phone app, the blog and branches. Use when a merchant asks 'why can't customers do X', 'is reviews on', 'العميل مش لاقي ...', 'ليه التقييمات مش ظاهرة'.",
  read: async ctx => {
    const [features, flags] = await Promise.all([
      featureService.getStoreFeatures(ctx.storeId),
      readStoreRow(ctx, FLAG_SELECT),
    ]);
    return {
      reviews: features.reviews,
      coupons: features.coupons,
      searchSuggestions: features.search_autocomplete,
      upsellCrossSell: features.upsell_crosssell,
      abandonedCartRecovery: features.abandoned_cart,
      pushNotifications: features.push_notifications,
      phoneApp: flags.pwaEnabled === true && features.pwa,
      blog: flags.blogEnabled === true,
      branches: flags.locationsEnabled === true,
    };
  },
});

const customerAccountStatus = freeRead({
  name: 'customer_account_status',
  capabilityId: 'storefront.customer-account',
  needs: 'store:settings',
  description:
    "What a customer gets in their account area on this store: returns, loyalty points, wallet balance and spending the wallet at checkout, reflecting which are switched on. Use for 'customer cannot see their points', 'is the wallet on', 'العميل مش لاقي النقاط', 'المحفظة شغالة؟'.",
  read: async ctx => {
    const [features, flags] = await Promise.all([
      featureService.getStoreFeatures(ctx.storeId),
      readStoreRow(ctx, FLAG_SELECT),
    ]);
    return {
      returns: features.returns,
      loyaltyPoints: features.loyalty && flags.loyaltyEnabled === true,
      wallet: features.customer_wallet,
      walletAtCheckout: features.customer_wallet && features.customer_wallet_checkout,
    };
  },
});

// ---- store.domain ----------------------------------------------------------------------------------------------------------------------------
type DomainArgs = { domain: string | null };
const domainConnect = change<DomainArgs>({
  name: 'domain_connect',
  capabilityId: 'store.domain',
  description:
    "Connect the merchant's own domain (for example mystore.com) to the store, or disconnect it with null. Connecting makes a pending claim: the card shows the DNS record to add at the registrar and the domain goes live only after DNS is verified (an unverified claim is released after 72 hours). Needs a plan with custom domains. Say: 'اربط الدومين بتاعي', 'connect my domain', 'فصل الدومين'.",
  schema: shape<DomainArgs>(
    {
      domain: f.nullable(
        f.str('The domain, e.g. mystore.com (no https://). null disconnects.', { max: 253 })
      ),
    },
    ['domain']
  ),
  policy: 'confirm',
  undo: 'reversible',
  // routes/store.routes.ts PUT /:id/domain (authorize store_admin; MFA is not re-checked here, see run-as-merchant.ts)
  gate: { roles: ROLES },
  audit: { action: 'store.domain.changed', resourceType: 'store', resourceId: () => undefined },
  state: ctx => readStoreDomainState(ctx.storeId),
  describe: (_ctx, a, st) => {
    const now = st as { domain: string | null; pendingDomain: string | null };
    const target = parseCustomDomain(a.domain); // throws the route's DOMAIN_INVALID message for an Ebda address or a malformed name
    const before = now.domain ?? now.pendingDomain ?? null;
    const records = target ? fallbackDnsRecords(target).filter(r => r.value) : [];
    return {
      summary: target
        ? pair(
            `هطلب ربط الدومين ${target} بالمتجر (بيبقى قيد التحقق لحد ما الـ DNS يتأكد)`,
            `Claim ${target} for the store (pending until DNS is verified)`
          )
        : pair('هفصل الدومين الخاص عن المتجر', 'Disconnect the custom domain from the store'),
      rows: [
        row('الدومين الخاص', 'Custom domain', before, target),
        ...records.map(r =>
          row(
            'سجل الـ DNS اللي هتضيفه عند مسجّل الدومين',
            'DNS record to add at your registrar',
            null,
            `${r.type} ${r.name} -> ${r.value}`
          )
        ),
      ],
      affectedCount: 1,
      restore: { domain: before },
    };
  },
  run: async (ctx, a) => {
    const r = await setStoreDomain(ctx.storeId, a.domain);
    const status = r.domain ? await r.provider.getDomain(r.domain) : null;
    return {
      claim: r.claimState,
      domain: r.domain,
      dnsRecords: status?.dnsRecords ?? (r.domain ? fallbackDnsRecords(r.domain) : []),
    };
  },
  inverse: (_a, restore) => ({
    tool: 'domain_connect',
    args: { domain: (restore as { domain: string | null }).domain },
  }),
});

// ---- store.slug-redirects --------------------------------------------------------------------------------------------------------------------
type RedirectArgs = { fromSlug: string };
type RedirectRow = { id: string; entityType: string; fromSlug: string; toSlug: string };
const slugRedirectDelete = change<RedirectArgs>({
  name: 'slug_redirect_delete',
  capabilityId: 'store.slug-redirects',
  description:
    "Delete an old-URL redirect by its old slug (the part of the old link, e.g. 'old-shoes'). Use when a stale redirect blocks reusing a slug or a link goes to the wrong page: 'امسح التحويل القديم', 'delete the old redirect', 'لينك قديم بيودي لصفحة غلط'. The card lists every redirect it removes; it cannot be undone (renaming the slug creates a new one).",
  schema: shape<RedirectArgs>({ fromSlug: f.str('The old slug of the redirect.', { max: 200 }) }, [
    'fromSlug',
  ]),
  policy: 'confirm',
  undo: 'irreversible',
  deletes: true,
  // routes/slug-redirects.routes.ts DELETE /:storeId/slug-redirects/:id
  gate: { roles: ROLES, feature: 'seo' },
  audit: { action: 'store.slug_redirect.deleted', resourceType: 'store' },
  state: async (ctx, a) => {
    const { rows } = await listSlugRedirects(ctx.storeId, { q: a.fromSlug, limit: 50 });
    const hits = rows
      .filter(r => r.fromSlug === a.fromSlug)
      .map(r => ({
        id: r.id,
        entityType: String(r.entityType),
        fromSlug: r.fromSlug,
        toSlug: r.toSlug,
      }))
      .sort((x, y) => x.id.localeCompare(y.id));
    if (hits.length === 0) throw new Error(`no redirect from "${a.fromSlug}" in this store`);
    return hits;
  },
  describe: (_ctx, _a, st) => {
    const hits = st as RedirectRow[];
    return {
      summary: pair(
        `هحذف ${hits.length} تحويل قديم (مش بيتراجع عنه)`,
        `Delete ${hits.length} old redirect(s) (cannot be undone)`
      ),
      rows: hits.map(h =>
        row(
          `تحويل (${h.entityType})`,
          `Redirect (${h.entityType})`,
          `${h.fromSlug} -> ${h.toSlug}`,
          null
        )
      ),
      affectedCount: hits.length,
    };
  },
  run: async (ctx, _a, st) => {
    for (const h of st as RedirectRow[]) await deleteSlugRedirect(ctx.storeId, h.id);
    return { deleted: (st as RedirectRow[]).length };
  },
});

// ---- AI jobs (store.agent-feed llms.txt, ai.translate-seo-bulk) ------------------------------------------------------------------------------
type JobState = {
  aiEnabled: boolean;
  activeJobId: string | null;
  products: number;
  categories: number;
};
/** The job row is created only if AI is on and none of this kind is already running; counts are read for the card (state is inside the store context). */
async function jobState(ctx: TurnCtx, kind: BulkAiJobSpec['kind']): Promise<JobState> {
  const db = await storeDb(ctx.storeId);
  const [aiEnabled, active, products, categories] = await Promise.all([
    isStoreAiEnabled(ctx.storeId),
    db.bulkAiJob.findFirst({
      where: { storeId: ctx.storeId, kind, status: { in: ['queued', 'running'] } },
      select: { id: true },
    }),
    db.product.count({ where: { storeId: ctx.storeId, deletedAt: null } }),
    db.category.count({ where: { storeId: ctx.storeId } }),
  ]);
  return { aiEnabled, activeJobId: active?.id ?? null, products, categories };
}
function assertJobMayStart(st: JobState, bounded: boolean): void {
  if (!st.aiEnabled) throw new Error('AI is switched off for this store: turn it on first');
  if (st.activeJobId) throw new Error('the same AI job is already running; wait for it to finish');
  if (bounded && st.products > MAX_JOB_PRODUCTS)
    throw new Error(
      `this store has ${st.products} products; the assistant runs AI sweeps up to ${MAX_JOB_PRODUCTS}. Run it from the AI tools screen`
    );
}
async function startJob(ctx: TurnCtx, spec: BulkAiJobSpec): Promise<{ jobId: string }> {
  await assertStoreAiEnabled(ctx.storeId); // the route's requireAiEnabled
  try {
    return { jobId: (await enqueueBulkAiJob(ctx.storeId, ctx.userId, spec)).id };
  } catch (err) {
    if (err instanceof BulkAiEnqueueError)
      throw new Error('could not start the AI job right now, try again in a minute'); // the row is already marked failed
    throw err;
  }
}

const llmsTxtGenerate = change<Rec>({
  name: 'llms_txt_generate',
  capabilityId: 'store.agent-feed',
  description:
    "Write the store's llms.txt (the short guide AI shopping assistants such as ChatGPT read about the store). Fills it only where it is empty, never overwrites text the merchant wrote. It queues a background AI job and returns its id. Say: 'اعمل llms.txt', 'خلي ChatGPT يعرف متجري', 'generate llms.txt'. It never creates or shows the agent key.",
  schema: shape<Rec>({}, []),
  policy: 'confirm',
  undo: 'irreversible',
  // routes/ai.routes.ts POST /bulk/llms-txt (store_admin + requireFeature('bulk_operations') + requireAiEnabled)
  gate: { roles: ROLES, feature: 'bulk_operations' },
  audit: { action: 'store.ai.llms_txt.requested', resourceType: 'store' },
  state: ctx => jobState(ctx, 'llms_txt'),
  describe: (_ctx, _a, st) => {
    assertJobMayStart(st as JobState, false);
    return {
      summary: pair(
        'هكتب ملف llms.txt للمتجر بالذكاء الاصطناعي (شغل في الخلفية)',
        'Write llms.txt for the store with AI (background job)'
      ),
      rows: [row('الذكاء الاصطناعي', 'AI', 'on', 'llms.txt job queued')],
      affectedCount: 1,
    };
  },
  run: ctx => startJob(ctx, { kind: 'llms_txt' }),
});

type TranslateArgs = { direction: 'to_ar' | 'to_en' };
const aiBulkTranslate = change<TranslateArgs>({
  name: 'ai_bulk_translate',
  capabilityId: 'ai.translate-seo-bulk',
  description:
    "Translate the whole catalogue with AI: 'to_ar' fills the EMPTY Arabic names and descriptions from the English, 'to_en' the reverse. Fill-only: text the merchant already wrote is never overwritten. It queues a background job and uses the store's daily AI requests (about one per product); allowed up to 50 products. Say: 'ترجم كل منتجاتي للانجليزي', 'translate my products to Arabic'.",
  schema: shape<TranslateArgs>(
    {
      direction: f.enum(
        ['to_ar', 'to_en'],
        "'to_ar' fills Arabic from English, 'to_en' fills English from Arabic."
      ),
    },
    ['direction']
  ),
  undo: 'irreversible', // a queued job has no whole-job undo: the merchant clears single fields afterwards (the registry's reset-field)
  // routes/ai.routes.ts POST /bulk/translate (store_admin + requireFeature('bulk_operations') + requireAiEnabled)
  gate: { roles: ROLES, feature: 'bulk_operations' },
  audit: { action: 'store.ai.bulk_translate.requested', resourceType: 'store' },
  state: ctx => jobState(ctx, 'translate'),
  describe: (_ctx, a, st) => {
    const s = st as JobState;
    assertJobMayStart(s, true);
    return {
      summary: pair(
        `هترجم ${s.products} منتج ${a.direction === 'to_ar' ? 'للعربي' : 'للإنجليزي'} بالذكاء الاصطناعي (بيملا الفاضي بس)`,
        `Translate ${s.products} products ${a.direction === 'to_ar' ? 'to Arabic' : 'to English'} with AI (fills empty fields only)`
      ),
      rows: [
        row(
          'الاتجاه',
          'Direction',
          null,
          a.direction === 'to_ar' ? 'English -> Arabic' : 'Arabic -> English'
        ),
        row('المنتجات', 'Products', null, s.products),
        row(
          'طلبات الذكاء الاصطناعي المتوقعة',
          'Estimated AI requests',
          null,
          `up to ${s.products}`
        ),
      ],
      affectedCount: s.products,
    };
  },
  run: (ctx, a) => startJob(ctx, { kind: 'translate', direction: a.direction }),
});

const aiBulkSeo = change<Rec>({
  name: 'ai_bulk_seo',
  capabilityId: 'ai.translate-seo-bulk',
  description:
    "Write search-result titles and descriptions (SEO) for the store, its categories and all products with AI. Fill-only: titles and descriptions the merchant wrote are never overwritten. It queues a background job and uses the store's daily AI requests; allowed up to 50 products. Say: 'اكتب وصف جوجل لكل المنتجات', 'write meta descriptions for all my products'.",
  schema: shape<Rec>({}, []),
  undo: 'irreversible',
  // routes/ai.routes.ts POST /bulk/seo (store_admin + requireFeature('bulk_operations') + requireAiEnabled)
  gate: { roles: ROLES, feature: 'bulk_operations' },
  audit: { action: 'store.ai.bulk_seo.requested', resourceType: 'store' },
  state: ctx => jobState(ctx, 'seo'),
  describe: (_ctx, _a, st) => {
    const s = st as JobState;
    assertJobMayStart(s, true);
    const items = s.products + s.categories + 1;
    return {
      summary: pair(
        `هكتب عناوين وأوصاف جوجل لـ ${items} عنصر بالذكاء الاصطناعي (بيملا الفاضي بس)`,
        `Write search titles and descriptions for ${items} items with AI (fills empty fields only)`
      ),
      rows: [
        row('المنتجات', 'Products', null, s.products),
        row('الأقسام', 'Categories', null, s.categories),
        row('طلبات الذكاء الاصطناعي المتوقعة', 'Estimated AI requests', null, `up to ${items}`),
      ],
      affectedCount: items,
    };
  },
  run: ctx => startJob(ctx, { kind: 'seo' }),
});

// ---- ai.switch-usage -------------------------------------------------------------------------------------------------------------------------
type SwitchArgs = { enabled: boolean };
const aiSwitchSet = change<SwitchArgs>({
  name: 'ai_switch_set',
  capabilityId: 'ai.switch-usage',
  description:
    "Turn the store's AI features on or off (the merchant's AI switch). Off means no AI call at all for this store: translation, SEO writing, the assistant's writing jobs and the autopilot stop. Say: 'اقفل الذكاء الاصطناعي', 'شغّل الذكاء', 'turn AI off'.",
  schema: shape<SwitchArgs>({ enabled: f.bool('true turns AI on, false turns it off.') }, [
    'enabled',
  ]),
  undo: 'reversible',
  // routes/ai.routes.ts PUT /settings (store_admin)
  gate: { roles: ROLES },
  audit: { action: 'store.ai.switch.changed', resourceType: 'store' },
  state: async ctx => ({ enabled: await isStoreAiEnabled(ctx.storeId) }),
  describe: (_ctx, a, st) => ({
    summary: a.enabled
      ? pair('هشغّل الذكاء الاصطناعي في المتجر', 'Turn AI on for the store')
      : pair('هقفل الذكاء الاصطناعي في المتجر (مفيش أي استخدام تاني)', 'Turn AI off for the store'),
    rows: [row('الذكاء الاصطناعي', 'AI features', (st as SwitchArgs).enabled, a.enabled)],
    affectedCount: 1,
    restore: { enabled: (st as SwitchArgs).enabled },
  }),
  run: (ctx, a) => setStoreAiEnabled(ctx.storeId, a.enabled),
  inverse: (_a, restore) => ({ tool: 'ai_switch_set', args: restore as Rec }),
});

// ---- store.pwa -------------------------------------------------------------------------------------------------------------------------------
const HEX = /^#[0-9A-Fa-f]{6}$/;
const hex = (description: string) =>
  fld(z.string().regex(HEX), { type: 'string', pattern: HEX.source, description });
const PWA_TEXT = [
  'appName',
  'appNameAr',
  'shortName',
  'shortNameAr',
  'description',
  'descriptionAr',
] as const;
const PWA_KEYS = [
  'pwaEnabled',
  ...PWA_TEXT,
  'themeColor',
  'backgroundColor',
  'installPromptEnabled',
  'offlineEnabled',
  'display',
] as const;
const PWA_LABELS: Record<string, [string, string]> = {
  pwaEnabled: ['تطبيق الموبايل', 'Phone app'],
  appName: ['اسم التطبيق', 'App name'],
  appNameAr: ['اسم التطبيق (عربي)', 'App name (Arabic)'],
  shortName: ['الاسم المختصر', 'Short name'],
  shortNameAr: ['الاسم المختصر (عربي)', 'Short name (Arabic)'],
  description: ['وصف التطبيق', 'App description'],
  descriptionAr: ['وصف التطبيق (عربي)', 'App description (Arabic)'],
  themeColor: ['لون التطبيق', 'Theme colour'],
  backgroundColor: ['لون الخلفية', 'Background colour'],
  installPromptEnabled: ['اقتراح تثبيت التطبيق', 'Install prompt'],
  offlineEnabled: ['العمل بدون إنترنت', 'Works offline'],
  display: ['شكل العرض', 'Display mode'],
};
const pwaSettingsUpdate = change<Rec>({
  name: 'pwa_settings_update',
  capabilityId: 'store.pwa',
  description:
    "Change the store's installable phone app (PWA): switch it on or off, the app name and short name (12 characters max, English and Arabic), description, theme and background colours (#RRGGBB), the install prompt, offline mode and display mode. Icons need an image upload and stay on the screen. Say: 'خلي متجري يتثبت على الموبايل', 'make my store installable', 'غير اسم التطبيق'. Needs a plan with the phone app.",
  schema: (() => {
    const base = shape<Rec>(
      {
        pwaEnabled: f.bool('Turn the phone app on or off.'),
        appName: f.text('App name.', { max: 100 }),
        appNameAr: f.text('App name in Arabic.', { max: 100 }),
        shortName: f.text('Short name under the icon, up to 12 characters.', { max: 12 }),
        shortNameAr: f.text('Short name in Arabic, up to 12 characters.', { max: 12 }),
        description: f.text('App description.', { max: 500 }),
        descriptionAr: f.text('App description in Arabic.', { max: 500 }),
        themeColor: hex('Theme colour as #RRGGBB.'),
        backgroundColor: hex('Background colour as #RRGGBB.'),
        installPromptEnabled: f.bool('Offer shoppers to install the app.'),
        offlineEnabled: f.bool('Let the app open without internet.'),
        display: f.enum(
          ['fullscreen', 'standalone', 'minimal-ui', 'browser'],
          'How the app is shown.'
        ),
      },
      []
    );
    return {
      jsonSchema: base.jsonSchema,
      args: base.args.refine(o => Object.keys(o).length > 0, {
        message: 'send at least one field',
      }),
    };
  })(),
  undo: 'reversible',
  // routes/pwa.routes.ts PUT /:storeId/pwa/settings (store_admin + requireFeature('pwa'))
  gate: { roles: ROLES, feature: 'pwa' },
  audit: { action: 'store.pwa.updated', resourceType: 'store' },
  state: async ctx => {
    const s = await PWAService.getSettings(ctx.storeId);
    const flat: Rec = { pwaEnabled: s.pwaEnabled, ...(s.settings as unknown as Rec) };
    return Object.fromEntries(PWA_KEYS.map(k => [k, flat[k] ?? (k === 'pwaEnabled' ? false : '')]));
  },
  describe: (_ctx, a, st) => {
    const keys = Object.keys(a);
    return {
      summary: pair(
        `هعدّل إعدادات تطبيق الموبايل (${keys.length})`,
        `Update the phone app settings (${keys.length})`
      ),
      rows: diffRows(PWA_LABELS, st as Rec, a),
      affectedCount: 1,
      restore: pick(st as Rec, keys),
    };
  },
  run: (ctx, a) => {
    const { pwaEnabled, ...settings } = a;
    return PWAService.updateSettings(ctx.storeId, {
      ...(pwaEnabled !== undefined ? { pwaEnabled: pwaEnabled as boolean } : {}),
      ...(Object.keys(settings).length > 0 ? { settings: settings as never } : {}),
    });
  },
  inverse: (_a, restore) =>
    restore && Object.keys(restore as Rec).length > 0
      ? { tool: 'pwa_settings_update', args: restore as Rec }
      : null,
});

// ---- store.qr-barcode ------------------------------------------------------------------------------------------------------------------------
const qrHex = (description: string) =>
  fld(z.string().regex(HEX_COLOR), { type: 'string', pattern: HEX_COLOR.source, description });
const QR_LABELS: Record<string, [string, string]> = {
  style: ['شكل النقاط', 'Dot style'],
  finder: ['شكل الأركان', 'Corner style'],
  frame: ['الإطار', 'Frame'],
  fg: ['لون الكود', 'Code colour'],
  bg: ['لون الخلفية', 'Background colour'],
  frameColor: ['لون الإطار', 'Frame colour'],
  ctaText: ['جملة تحت الكود', 'Call-to-action text'],
  ctaLang: ['لغة الجملة', 'Call-to-action language'],
  logo: ['لوجو في النص', 'Logo in the middle'],
  whatsappText: ['أول رسالة واتساب', 'First WhatsApp message'],
};
type QrFlat = {
  style: string;
  finder: string;
  frame: string;
  fg: string;
  bg: string;
  frameColor: string;
  ctaText: string | null;
  ctaLang: string | null;
  logo: boolean;
  whatsappText: string | null;
};
const flattenQr = (raw: unknown): QrFlat => {
  const s = readQrSettings(raw);
  return {
    ...s.design,
    ctaText: s.design.cta?.text ?? null,
    ctaLang: s.design.cta?.lang ?? null,
    whatsappText: s.whatsappText ?? null,
  } as unknown as QrFlat;
};
/** The settings the route would store, validated by the SAME schema (contrast included); a bad result is a plain Error at preview. */
function buildQr(now: QrFlat, patch: Partial<QrFlat>) {
  const next = { ...now, ...patch };
  const ctaText = patch.ctaText !== undefined ? patch.ctaText : now.ctaText;
  if (patch.ctaLang !== undefined && ctaText === null)
    throw new Error('send the call-to-action text together with its language');
  const out = qrSettingsSchema.safeParse({
    design: {
      style: next.style,
      finder: next.finder,
      frame: next.frame,
      fg: next.fg,
      bg: next.bg,
      frameColor: next.frameColor,
      cta: ctaText === null ? null : { text: ctaText, lang: next.ctaLang ?? 'ar' },
      logo: next.logo,
    },
    ...(next.whatsappText ? { whatsappText: next.whatsappText } : {}),
  });
  if (!out.success) throw new Error(out.error.issues[0]?.message ?? 'invalid QR design');
  return out.data;
}
const qrDesignUpdate = change<Partial<QrFlat>>({
  name: 'qr_design_update',
  capabilityId: 'store.qr-barcode',
  description:
    "Change how the store's QR codes look: dot style, corner style, frame, colours (#RRGGBB, dark code on a light background so it still scans), the text under the code and its language, a logo in the middle, and the first WhatsApp message of the chat code. Printing and downloading codes stays on the Codes screen. Say: 'غير شكل الـ QR', 'خلي الكود ذهبي', 'change my QR colours'. Needs a plan with QR codes.",
  schema: (() => {
    const base = shape<Partial<QrFlat>>(
      {
        style: f.enum([...QR_STYLES], 'Dot style.'),
        finder: f.enum([...QR_FINDERS], 'Corner style.'),
        frame: f.enum([...QR_FRAMES], 'Frame around the code.'),
        fg: qrHex('Code colour as #RRGGBB (dark).'),
        bg: qrHex('Background colour as #RRGGBB (light).'),
        frameColor: qrHex('Frame colour as #RRGGBB.'),
        ctaText: txt('Short text under the code (40 characters max).', 40),
        ctaLang: f.enum(['ar', 'en'], 'Language of the text under the code.'),
        logo: f.bool('Put the store logo in the middle.'),
        whatsappText: txt('First message of the WhatsApp chat code.', 200),
      },
      []
    );
    return {
      jsonSchema: base.jsonSchema,
      args: base.args.refine(o => Object.keys(o).length > 0, {
        message: 'send at least one field',
      }),
    };
  })(),
  undo: 'reversible',
  // routes/qr.routes.ts PUT /:storeId/qr/settings (store_admin + requireFeature('inventory.barcode'))
  gate: { roles: ROLES, feature: 'inventory.barcode' },
  audit: { action: 'store.qr.updated', resourceType: 'store' },
  state: async ctx => flattenQr((await readStoreRow(ctx, { settings: true })).settings),
  describe: (_ctx, a, st) => {
    buildQr(st as QrFlat, a); // refuses a design that would not scan, with the schema's message
    const keys = Object.keys(a);
    const before = st as QrFlat;
    // the text and its language go back together, so a restore never leaves a half-set call-to-action
    const restoreKeys = keys.includes('ctaText') && before.ctaLang ? [...keys, 'ctaLang'] : keys;
    return {
      summary: pair(
        `هعدّل شكل أكواد الـ QR (${keys.length})`,
        `Update the QR code design (${keys.length})`
      ),
      rows: diffRows(QR_LABELS, before as unknown as Rec, a as Rec),
      affectedCount: 1,
      restore: pick(before as unknown as Rec, [...new Set(restoreKeys)]),
    };
  },
  run: (ctx, a, st) => StoreService.updateQrSettings(ctx.storeId, buildQr(st as QrFlat, a)),
  inverse: (_a, restore) =>
    restore && Object.keys(restore as Rec).length > 0
      ? { tool: 'qr_design_update', args: restore as Rec }
      : null,
});

// ---- store.locations -------------------------------------------------------------------------------------------------------------------------
const LOCATION_TEXT = [
  'nameAr',
  'countryAr',
  'addressAr',
  'phone',
  'whatsapp',
  'hours',
  'hoursAr',
] as const;
const LOCATION_KEYS = [
  'name',
  'country',
  'address',
  ...LOCATION_TEXT,
  'mapsUrl',
  'isPublished',
  'position',
] as const;
const LOCATION_LABELS: Record<string, [string, string]> = {
  name: ['اسم الفرع', 'Branch name'],
  nameAr: ['اسم الفرع (عربي)', 'Branch name (Arabic)'],
  country: ['الدولة', 'Country'],
  countryAr: ['الدولة (عربي)', 'Country (Arabic)'],
  address: ['العنوان', 'Address'],
  addressAr: ['العنوان (عربي)', 'Address (Arabic)'],
  phone: ['التليفون', 'Phone'],
  whatsapp: ['واتساب', 'WhatsApp'],
  mapsUrl: ['لينك الخريطة', 'Maps link'],
  hours: ['مواعيد العمل', 'Opening hours'],
  hoursAr: ['مواعيد العمل (عربي)', 'Opening hours (Arabic)'],
  isPublished: ['ظاهر في المتجر', 'Shown on the store'],
  position: ['الترتيب', 'Order'],
};
const locationFields = {
  nameAr: txt('Branch name in Arabic.', 200),
  countryAr: txt('Country in Arabic.', 100),
  addressAr: txt('Address in Arabic.', 500),
  phone: txt('Branch phone.', 40),
  whatsapp: txt('Branch WhatsApp number.', 40),
  mapsUrl: fld(locationInputSchema.shape.mapsUrl, {
    type: 'string',
    description: 'Google Maps link (https). null clears it.',
  }),
  hours: txt('Opening hours.', 200),
  hoursAr: txt('Opening hours in Arabic.', 200),
  isPublished: f.bool('Show the branch on the store.'),
  position: f.int('Order among the branches, 0 first.', { max: 10_000 }),
};
type LocationRow = Rec & { id: string };
async function locationRow(ctx: TurnCtx, id: string): Promise<LocationRow> {
  // store-scoped list: an id from another store is simply absent
  const hit = (await LocationsService.list(ctx.storeId)).find(l => l.id === id);
  if (!hit) throw new Error('location not found');
  return {
    id: hit.id,
    updatedAt: hit.updatedAt,
    ...pick(hit as unknown as Rec, [...LOCATION_KEYS]),
  };
}

type LocationAddArgs = Rec & { name: string; country: string; address: string };
const locationAdd = change<LocationAddArgs>({
  name: 'location_add',
  capabilityId: 'store.locations',
  description:
    "Add a branch or pickup location to the store: name, country, address, and optionally phone, WhatsApp, Google Maps link, opening hours. Say: 'ضيف فرع', 'add a branch', 'عنوان الفرع الجديد'. Undo removes it again (that asks for its own confirmation).",
  schema: shape<LocationAddArgs>(
    {
      name: f.str('Branch name.', { max: 200 }),
      country: f.str('Country, e.g. Egypt.', { max: 100 }),
      address: f.str('Street address.', { max: 500 }),
      ...locationFields,
    },
    ['name', 'country', 'address']
  ),
  undo: 'compensating',
  // routes/locations.routes.ts POST /stores/:storeId/locations (store_admin)
  gate: { roles: ROLES },
  audit: { action: 'store.location.created', resourceType: 'store' },
  state: async ctx => ({ branches: (await LocationsService.list(ctx.storeId)).length }),
  describe: (_ctx, a) => ({
    summary: pair(`هضيف فرع جديد: ${a.name}`, `Add a new branch: ${a.name}`),
    rows: diffRows(LOCATION_LABELS, {}, a),
    affectedCount: 1,
    restore: null,
  }),
  run: (ctx, a) => LocationsService.create(ctx.storeId, locationInputSchema.parse(a)),
  inverse: (_a, _restore, result) => {
    const id = (result as { id?: string } | null)?.id;
    return id ? { tool: 'location_delete', args: { locationId: id } } : null;
  },
});

type LocationUpdateArgs = Rec & { locationId: string };
const locationUpdate = change<LocationUpdateArgs>({
  name: 'location_update',
  capabilityId: 'store.locations',
  description:
    "Change a branch (pickup location): its name, address, phone, WhatsApp, Maps link, opening hours, whether it shows on the store, or its order. Needs the branch id from the Branding screen. Say: 'غير عنوان الفرع', 'update the branch hours', 'اقفل الفرع ده'.",
  schema: shape<LocationUpdateArgs>(
    {
      locationId: f.id('The branch id.'),
      name: f.str('Branch name.', { max: 200 }),
      country: f.str('Country.', { max: 100 }),
      address: f.str('Street address.', { max: 500 }),
      ...locationFields,
    },
    ['locationId']
  ),
  undo: 'reversible',
  // routes/locations.routes.ts PUT /stores/:storeId/locations/:id (store_admin)
  gate: { roles: ROLES },
  audit: { action: 'store.location.updated', resourceType: 'store', resourceId: a => a.locationId },
  state: (ctx, a) => locationRow(ctx, a.locationId),
  describe: (_ctx, a, st) => {
    const patch = Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'locationId'));
    const keys = Object.keys(patch);
    if (keys.length === 0) throw new Error('send at least one field to change');
    return {
      summary: pair(`هعدّل بيانات الفرع (${keys.length})`, `Update the branch (${keys.length})`),
      rows: diffRows(LOCATION_LABELS, st as Rec, patch),
      affectedCount: 1,
      restore: pick(st as Rec, keys),
    };
  },
  run: async (ctx, a) => {
    const { locationId, ...patch } = a;
    const done = await LocationsService.update(
      ctx.storeId,
      locationId,
      locationInputSchema.partial().parse(patch)
    );
    if (!done) throw new Error('location not found');
    return { id: locationId };
  },
  inverse: (a, restore) =>
    restore && Object.keys(restore as Rec).length > 0
      ? { tool: 'location_update', args: { locationId: a.locationId, ...(restore as Rec) } }
      : null,
});

type LocationDeleteArgs = { locationId: string };
const locationDelete = change<LocationDeleteArgs>({
  name: 'location_delete',
  capabilityId: 'store.locations',
  description:
    "Delete a branch (pickup location) for good. The card names the branch and it cannot be undone. Say: 'امسح الفرع', 'delete this branch'. To only hide it, use location_update with isPublished false.",
  schema: shape<LocationDeleteArgs>({ locationId: f.id('The branch id.') }, ['locationId']),
  policy: 'confirm',
  undo: 'irreversible',
  deletes: true,
  // routes/locations.routes.ts DELETE /stores/:storeId/locations/:id (store_admin)
  gate: { roles: ROLES },
  audit: { action: 'store.location.deleted', resourceType: 'store', resourceId: a => a.locationId },
  state: (ctx, a) => locationRow(ctx, a.locationId),
  describe: (_ctx, _a, st) => {
    const l = st as Rec;
    return {
      summary: pair(
        `هحذف الفرع ${String(l.name)} (مش بيتراجع عنه)`,
        `Delete the branch ${String(l.name)} (cannot be undone)`
      ),
      rows: [row('الفرع', 'Branch', `${String(l.name)} - ${String(l.address)}`, null)],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    if (!(await LocationsService.remove(ctx.storeId, a.locationId)))
      throw new Error('location not found');
    return { deleted: a.locationId };
  },
});

// pq-allow(unused-export): wired into changeTools() by the controller (E-phase wiring), imported by tests/unit/assistant-tools-storefront.test.ts
export function storefrontTools(): ToolSpec[] {
  return [
    pagesList,
    shopperFeaturesStatus,
    customerAccountStatus,
    domainConnect,
    slugRedirectDelete,
    llmsTxtGenerate,
    aiBulkTranslate,
    aiBulkSeo,
    aiSwitchSet,
    pwaSettingsUpdate,
    qrDesignUpdate,
    locationAdd,
    locationUpdate,
    locationDelete,
  ];
}
