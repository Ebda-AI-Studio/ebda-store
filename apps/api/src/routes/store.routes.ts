import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { storeScopeContext, tenantContext } from '../middleware/tenant-context';
import { requireStoreAccess } from '../middleware/store-access';
import {
  Prisma,
  prisma,
  StoreStatus,
  currentStoreId,
  withUser,
  withStore,
  asPlatformOperator,
} from '@ebda/database';
import { StoreService, type SocialLinksPatch } from '../services/store.service';
import { acquisitionForAdmin } from '../services/ebda-ads.service';
import { toSafeStoreResponse } from '../lib/store-response';
import { resolveDomainService, type DomainProvider } from '../services/domain-provider';
import {
  DomainChangeError,
  fallbackDnsRecords,
  setStoreDomain,
} from '../services/store-domain.service';
import { DomainClaimService } from '../services/domain-claim.service';
import { assertStoreCreationBudget, withStoreCreationLock } from '../services/store-creation-limit';
import { merchantSenderPrefixInput } from '../services/email-sender';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { insertAuditLog } from '../lib/definer';
import { getAuthUser } from '../utils/store-helpers';
import { requireFeature } from '../middleware/feature-gate';
import { featureService } from '../services/feature.service';
import { auditLog } from '../middleware/security';
import {
  isSafeUrl,
  normalizeEgyptianMobile,
  isValidTimeZone,
  storeSlugSchema,
  storeSlugIssueCode,
  deliveryDaysSchema,
  instalmentsSchema,
  deliveryOffDaysSchema,
  daysAheadSchema,
  receiptBarcodeShapeSchema,
  footerBottomBarSchema,
  normalizeStoredBottomBar,
  reservedSettingsKeys,
  ECHOED_SERVER_OWNED_KEYS,
  phoneSchema,
} from '@ebda/shared';
import { preserveMaskedPixelSecrets } from '../lib/marketing-pixels-secrets';
import { floatingWidgetLinkIssues } from '../lib/floating-widget-links';
import { themeSchema } from '../lib/theme-schema';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { StoreFaqService } from '../services/store-faq.service';
import { closeClaimsOnSlugGrant } from '../services/trust-grants';
import {
  closeAppealsOnReactivation,
  recordSuspension,
  rejectAppeal,
  type TrustDb,
} from '../services/trust-requests.service';

const router = Router();

// Every `/:id` route acts on THAT store, and `/stores` is mounted with no request
// transaction (index.ts: the domain handlers make slow third-party calls). Scope each
// one to its store with `storeScopeContext` (runInStoreScope: every query is its own
// short store transaction), so the code-level tenant guard (R-EBDA-003) and RLS on
// `stores` (R-EBDA-005) see the store; authorization is still `requireStoreAccess`.
router.param('id', (req, res, next) => storeScopeContext(req, res, next));

/**
 * Parse a store create/update body. A rejected slug is raised as its own stable
 * 400 code (`SLUG_RESERVED`, `SLUG_TOO_SHORT`, …) rather than the generic
 * VALIDATION_ERROR, so the admin and API clients can key on it.
 */
function parseStoreBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const code = storeSlugIssueCode(issue);
    if (code) throw new AppError(400, code, issue.message);
  }
  throw result.error;
}

/**
 * Store-wide delivery estimate (`settings.deliveryDays`, business days): null clears, anything
 * else must satisfy the shared schema. Applied on EVERY route that can write `settings`
 * (create + update); super-admin provisioning uses a strict object that drops the key.
 */
function addDeliveryDaysIssues(
  settings: Record<string, unknown> | undefined,
  ctx: z.RefinementCtx
) {
  const dd = settings?.deliveryDays;
  if (dd === undefined || dd === null) return;
  const parsed = deliveryDaysSchema.safeParse(dd);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryDays', ...issue.path],
      message: issue.message,
    });
  }
}

/** `settings.deliveryOffDays` (weekdays with no delivery): null clears; else the shared schema. */
function addDeliveryOffDaysIssues(
  settings: Record<string, unknown> | undefined,
  ctx: z.RefinementCtx
) {
  const od = settings?.deliveryOffDays;
  if (od === undefined || od === null) return;
  const parsed = deliveryOffDaysSchema.safeParse(od);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryOffDays', ...issue.path],
      message: issue.message,
    });
  }
}

/**
 * `settings.checkoutDelivery.daysAhead` (Phase B4, Ruling B4-7): null / absent keeps today and
 * tomorrow; else an integer 1-14. The rest of `checkoutDelivery` passes through unvalidated, as
 * before (a merchant's windows and note keep working exactly as saved).
 */
function addCheckoutDeliveryIssues(
  settings: Record<string, unknown> | undefined,
  ctx: z.RefinementCtx
) {
  const cd = settings?.checkoutDelivery;
  if (!cd || typeof cd !== 'object') return;
  const v = (cd as Record<string, unknown>).daysAhead;
  if (v === undefined || v === null) return;
  if (daysAheadSchema.safeParse(v).success) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['checkoutDelivery', 'daysAhead'],
    message: 'Days ahead must be a whole number from 1 to 14',
  });
}

/** `settings.receiptBarcodeShape`: plain | off | one of the approved shape ids; null clears. */
function addReceiptBarcodeShapeIssues(
  settings: Record<string, unknown> | undefined,
  ctx: z.RefinementCtx
) {
  const v = settings?.receiptBarcodeShape;
  if (v === undefined || v === null) return;
  if (receiptBarcodeShapeSchema.safeParse(v).success) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['receiptBarcodeShape'],
    message: 'Unknown receipt barcode shape',
  });
}

/** `settings.packingSlipNote`: the optional footer text printed on packing slips (<= 300 chars; null/'' clears). */
function addPackingSlipNoteIssues(
  settings: Record<string, unknown> | undefined,
  ctx: z.RefinementCtx
) {
  const v = settings?.packingSlipNote;
  if (v === undefined || v === null) return;
  if (typeof v === 'string' && v.length <= 300) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['packingSlipNote'],
    message: 'Packing slip note must be text up to 300 characters',
  });
}

/** `settings.instalments` (PDP instalment estimate, B2-9): null clears; else the strict shared schema. */
function addInstalmentsIssues(settings: Record<string, unknown> | undefined, ctx: z.RefinementCtx) {
  const v = settings?.instalments;
  if (v === undefined || v === null) return;
  const parsed = instalmentsSchema.safeParse(v);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['instalments', ...issue.path],
      message: issue.message,
    });
  }
}

/**
 * Everything the open `settings` blob must satisfy, on EVERY route that writes it (create AND
 * update — a check on update only leaves POST /stores as the bypass):
 * - `contact.addressUrl` renders into `<a href>`: a `javascript:`/`data:` value is stored XSS;
 * - `deliveryDays`, `deliveryOffDays` and `instalments` (above);
 * - `floatingWidget` button links render as `<a href>`; the dedicated route validates them, so
 *   this generic path must too (S2);
 * - `footerLinks.bottomBar` (the footer legal row's toggles + © override, S-01).
 * All other keys pass through unvalidated (existing behaviour).
 */
function addSettingsIssues(settings: Record<string, unknown> | undefined, ctx: z.RefinementCtx) {
  // Server-owned keys (e.g. the Ebda Chat link) are never accepted from a client.
  for (const key of reservedSettingsKeys(settings)) {
    // BE:F-2 / S-8: a flag echoed back from a stale whole-settings copy is stripped by the service, not refused.
    if (ECHOED_SERVER_OWNED_KEYS.includes(key)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: `settings.${key} is managed by the platform and cannot be set`,
    });
  }
  const contact = settings?.contact;
  if (contact && typeof contact === 'object') {
    const addressUrl = (contact as Record<string, unknown>).addressUrl;
    if (addressUrl !== undefined && addressUrl !== null && addressUrl !== '') {
      if (!isSafeUrl(addressUrl)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contact', 'addressUrl'],
          message:
            'Link must be a relative path or use http(s)/mailto/tel — javascript: is not allowed',
        });
      }
    }
  }
  addDeliveryDaysIssues(settings, ctx);
  addDeliveryOffDaysIssues(settings, ctx);
  addCheckoutDeliveryIssues(settings, ctx);
  addReceiptBarcodeShapeIssues(settings, ctx);
  addPackingSlipNoteIssues(settings, ctx);
  addInstalmentsIssues(settings, ctx);
  // The footer legal row's toggles + © override (S-01): typed, length-capped.
  const footerLinks = settings?.footerLinks;
  if (footerLinks && typeof footerLinks === 'object' && 'bottomBar' in footerLinks) {
    const parsed = footerBottomBarSchema.safeParse(
      normalizeStoredBottomBar((footerLinks as Record<string, unknown>).bottomBar)
    );
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['footerLinks', 'bottomBar', ...issue.path],
          message: issue.message,
        });
      }
    }
  }
  for (const issue of floatingWidgetLinkIssues(settings)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }
}

// Validation schemas
export const createStoreSchema = z.object({
  name: z.string().min(1).max(100),
  // `<slug>.ebda.app`: lowercase a-z0-9/hyphen, 3-40 chars, no leading/trailing/
  // double hyphen, and never a reserved label (`app`, `api`, `www`, …). One
  // definition in @ebda/shared — the same list the host parser and resolver use.
  slug: storeSlugSchema.optional(),
  domain: z.string().optional(),
  settings: z.record(z.string(), z.any()).superRefine(addSettingsIssues).optional(),
});

const heroNullableStr = (maxLen: number) =>
  z.preprocess(v => (v === '' ? null : v), z.string().max(maxLen).nullable().optional());

// Hero CTA link is rendered into an `<a href>` on the storefront. Validate the
// URL scheme so a `javascript:` / `data:` / `vbscript:` value can never be
// persisted (stored-XSS guard). Allows site-relative paths + http(s)/mailto/tel
// via the shared `isSafeUrl` allowlist. Empty string → null (CTA falls back to
// `/products` at render).
const heroCtaLinkSchema = z.preprocess(
  v => (v === '' ? null : v),
  z
    .string()
    .max(500)
    .refine(isSafeUrl, {
      message:
        'Link must be a relative path or use http(s)/mailto/tel — javascript: is not allowed',
    })
    .nullable()
    .optional()
);

// #1518: exported so `tests/unit/store-update-persists-every-accepted-field.test.ts`
// can derive its field-coverage check from the schema itself instead of a
// hand-maintained field list that can silently drift from it — which is
// exactly how returnWindowDays/locationsEnabled shipped un-persisted the
// first time (see that test's header comment).
export const updateStoreSchema = createStoreSchema.partial().extend({
  heroTitle: heroNullableStr(200),
  heroTitleAr: heroNullableStr(200),
  heroSubtitle: heroNullableStr(500),
  heroSubtitleAr: heroNullableStr(500),
  heroCtaText: heroNullableStr(100),
  heroCtaTextAr: heroNullableStr(100),
  heroCtaLink: heroCtaLinkSchema,
  heroImage: heroNullableStr(1000),
  blogEnabled: z.boolean().optional(),
  locationsEnabled: z.boolean().optional(),
  // The zone the store's finance reports / tax periods count days in
  // (Ruling FRT-2). A name the runtime cannot resolve is REJECTED, not
  // silently coerced to Egypt days (issue 2411).
  timezone: z
    .string()
    .refine(isValidTimeZone, { message: 'timezone must be a valid IANA time zone' })
    .optional(),
  // Return policy -> Product JSON-LD hasMerchantReturnPolicy.
  // `.nullable()` is load-bearing: the admin sends null to CLEAR a declared
  // policy, and null must persist as "not declared" rather than being dropped.
  // 0 is a valid, meaningful value ("returns not accepted"), so no .positive().
  returnWindowDays: z.number().int().min(0).max(3650).nullable().optional(),
  returnFeesPaidBy: z.enum(['merchant', 'customer']).nullable().optional(),
  // Same `settings` checks as create (`addSettingsIssues`).
  settings: z.record(z.string(), z.any()).superRefine(addSettingsIssues).optional(),
});

const lookBody = z
  .object({
    lookId: z.string().max(40),
    design: z.enum(['keep', 'reset']).default('keep'),
    // from a preview: refuse with 409 DRAFT_MOVED when the page changed since
    revisionToken: z.string().max(64).optional(),
  })
  .strict();
const lookPreviewBody = lookBody.omit({ revisionToken: true });

// Helpers that coerce empty strings and nulls to undefined before validation
const optionalStr = (maxLen: number) =>
  z.preprocess(v => (v === '' || v === null ? undefined : v), z.string().max(maxLen).optional());
// A phone-shaped setting (G12): blank clears it, anything else must be a real phone number.
const optionalPhone = () =>
  z.preprocess(v => (v === '' || v === null ? undefined : v), phoneSchema.optional());

// Merchants routinely paste the entire `<meta name="google-site-verification"
// content="..." />` tag instead of just the content token. Extract the token
// before validation so the storefront emits a valid meta tag and the
// verification flow doesn't silently fail.
const optionalGoogleVerification = z.preprocess(v => {
  if (typeof v !== 'string') return v === null ? undefined : v;
  const trimmed = v.trim();
  if (trimmed === '') return undefined;
  const tagMatch = trimmed.match(/content\s*=\s*["']([^"']+)["']/i);
  return tagMatch ? tagMatch[1].trim() : trimmed;
}, z.string().max(200).optional());

const optionalUrl = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z.string().url().max(500).optional()
);

// Like `optionalUrl` but additionally enforces the safe-scheme allowlist. Use
// for any URL that is rendered into an `<a href>` on the storefront (e.g. the
// announcement-bar link) so a `javascript:`/`data:` value can't be stored.
// `z.string().url()` alone ACCEPTS `javascript:alert(1)` — it only checks URL
// shape, not scheme safety.
const safeOptionalUrl = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z
    .string()
    .max(500)
    .refine(isSafeUrl, {
      message:
        'Link must be a relative path or use http(s)/mailto/tel — javascript: is not allowed',
    })
    .optional()
);

const optionalEmail = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z.string().email().max(255).optional()
);

// Sender prefix of a store's mail: allowlist, see merchantSenderPrefixInput (services/email-sender.ts).
const optionalEmailLocalPart = merchantSenderPrefixInput;

const seoSchema = z
  .object({
    metaTitle: optionalStr(200),
    metaTitleAr: optionalStr(200),
    metaDescription: optionalStr(500),
    metaDescriptionAr: optionalStr(500),
    // AEO — conversational answer-engine copy.
    metaDescriptionAeo: z.string().max(400).optional().nullable(),
    metaDescriptionAeoAr: z.string().max(400).optional().nullable(),
    ogImage: optionalUrl,
    twitterHandle: optionalStr(50),
    googleSiteVerification: optionalGoogleVerification,
    emailSenderLocalPart: optionalEmailLocalPart,
    // "Hide my store from search engines": stored as `store.settings.hideFromSearchEngines` (no column, so no
    // store-resolver / DO-schema change) and exposed to the storefront through PUBLIC_SETTINGS_KEYS.
    hideFromSearchEngines: z.boolean().optional(),
  })
  .strip();

// Store WhatsApp number (free-tier `wa.me` chat target, SP8). Must be an
// Egyptian mobile; saved as E.164 (`+201012345678`). An empty value CLEARS it
// (null) so the storefront hides every wa.me button — unlike `optionalStr`,
// where '' would be "no change".
const optionalWhatsappNumber = z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? null : v),
  z
    .string()
    .max(50)
    .transform((v, ctx) => {
      const e164 = normalizeEgyptianMobile(v);
      if (!e164) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Enter a valid Egyptian mobile number (010, 011, 012 or 015)',
        });
        return z.NEVER;
      }
      return e164;
    })
    .nullable()
    .optional()
);

const contactSchema = z
  .object({
    email: optionalEmail,
    phone: optionalPhone(),
    phoneAr: optionalPhone(),
    whatsapp: optionalWhatsappNumber,
    address: optionalStr(500),
    addressAr: optionalStr(500),
    // Phase D.6 — WhatsApp bot "Locations & Hours" branch
    businessHours: optionalStr(500),
    googleMapsUrl: optionalStr(2000),
  })
  .strip();

const brandingSchema = z
  .object({
    name: z.preprocess(v => (v === null ? undefined : v), z.string().min(1).max(200).optional()),
    nameAr: optionalStr(200),
    logo: optionalUrl,
    logoAr: optionalUrl,
    favicon: optionalUrl,
    description: optionalStr(1000),
    descriptionAr: optionalStr(1000),
  })
  .strip();

const socialSchema = z
  .object({
    // Social-link fields are rendered directly into `<a href>` on the
    // storefront footer. Use `safeOptionalUrl` (not `optionalUrl`) so a
    // `javascript:`/`data:` value is rejected at save time (stored-XSS guard).
    // `optionalUrl` uses `z.string().url()` which only checks URL shape and
    // silently accepts `javascript:alert(1)`.
    facebook: safeOptionalUrl,
    instagram: safeOptionalUrl,
    twitter: safeOptionalUrl,
    tiktok: safeOptionalUrl,
    youtube: safeOptionalUrl,
    snapchat: safeOptionalUrl,
    linkedin: safeOptionalUrl,
    wikidata: safeOptionalUrl,
    wikipedia: safeOptionalUrl,
    // NOTE: `whatsapp` is intentionally NOT a social-links field. The WhatsApp
    // display number is canonical on the `store.whatsapp` column (edited in
    // /contact). Keeping it here too let `/social` store a divergent value that
    // never synced with the column (2026-06-09 overlap audit #8). The storefront
    // footer/floating-widget now DERIVE the WhatsApp link from `contact.whatsapp`
    // (with any legacy `socialLinks.whatsapp` only as a fallback for old rows).
  })
  .strip();

// Announcement payload mirrors the @ebda/shared AnnouncementBar shape. The
// storefront renders linkText / linkTextAr / dismissible alongside the link
// itself, so the schema must accept (and the .strip() must not drop) them.
const announcementSchema = z
  .object({
    enabled: z.boolean().optional(),
    text: z.string().max(500).optional(),
    textAr: z.string().max(500).optional(),
    bgColor: z.string().max(50).optional(),
    textColor: z.string().max(50).optional(),
    link: safeOptionalUrl,
    linkText: optionalStr(200),
    linkTextAr: optionalStr(200),
    dismissible: z.boolean().optional(),
  })
  .strip();

const marketingPixelsSchema = z.record(z.string(), z.unknown());

// Floating widget — sticky button group on the storefront. Schema mirrors
// the FloatingWidgetConfig type in @ebda/shared. The buttons array can
// hold any FloatingButton shape; we use z.record for the per-button object
// so adding a new optional field on the client (e.g. a new social kind)
// doesn't immediately require a backend redeploy. Length caps prevent
// runaway payloads — a merchant should not be configuring 200 buttons.
const floatingButtonSchema = z
  .object({
    id: z.string().max(64),
    // Keep in sync with FloatingButtonKind in @ebda/shared. The social kinds
    // inherit their value from the store's contact/socialLinks at render time
    // when left blank (so a merchant can save them empty on purpose).
    kind: z.enum([
      'whatsapp',
      'instagram',
      'phone',
      'email',
      'music',
      'custom',
      'tiktok',
      'snapchat',
      'youtube',
      'facebook',
      'x',
      'telegram',
    ]),
    label: optionalStr(200),
    labelAr: optionalStr(200),
    bgColor: optionalStr(50),
    iconColor: optionalStr(50),
    iconUrl: optionalStr(500),
    whatsappPhone: optionalPhone(),
    whatsappMessage: optionalStr(500),
    instagramHandle: optionalStr(100),
    phoneNumber: optionalPhone(),
    emailAddress: optionalStr(255),
    emailSubject: optionalStr(200),
    musicUrl: optionalStr(500),
    musicLoop: z.boolean().optional(),
    // Rendered as an `<a href>` — scheme-validated (S2); `optionalStr` accepted `javascript:`.
    customHref: safeOptionalUrl,
    // New social kinds (must be listed explicitly — the schema uses .strip(),
    // so an un-listed field would be silently dropped on save).
    tiktokHandle: optionalStr(100),
    snapchatHandle: optionalStr(100),
    youtubeUrl: safeOptionalUrl,
    facebookUrl: safeOptionalUrl,
    xHandle: optionalStr(100),
    telegramHandle: optionalStr(100),
  })
  .strip();

const floatingWidgetSchema = z
  .object({
    enabled: z.boolean().optional(),
    position: z.enum(['br', 'bl', 'tr', 'tl']).optional(),
    expandDirection: z.enum(['up', 'down', 'left', 'right']).optional(),
    toggleBgColor: optionalStr(50),
    toggleIconUrl: optionalStr(500),
    toggleLabel: optionalStr(200),
    toggleLabelAr: optionalStr(200),
    startExpanded: z.boolean().optional(),
    hideOnMobile: z.boolean().optional(),
    hideOnDesktop: z.boolean().optional(),
    buttons: z.array(floatingButtonSchema).max(50).optional(),
  })
  .strip();

/**
 * @swagger
 * /stores:
 *   get:
 *     summary: List all stores
 *     description: Get paginated list of all stores (admin only)
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: List of stores
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     stores:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Store'
 *                     meta:
 *                       $ref: '#/components/schemas/Pagination'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */
router.get(
  '/',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page, limit } = req.query;

      // The store payload names its owner (`users`, identity-scoped under strict RLS): read
      // as the acting user, who is either a super_admin (sees every owner) or the owner.
      // A super_admin's list is the platform directory: the 'platform-operator' hatch.
      const asActor = <T>(fn: () => Promise<T>) =>
        req.user!.role === 'super_admin'
          ? asPlatformOperator(req.user!.userId, fn)
          : withUser(req.user!.userId, fn);
      const result = await asActor(() =>
        StoreService.list({
          page: page ? parseInt(page as string) : undefined,
          limit: limit ? parseInt(limit as string) : undefined,
          ownerId: req.user!.role === 'store_admin' ? req.user!.userId : undefined,
        })
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:id - Get store by ID (requires store_admin or super_admin)
router.get(
  '/:id',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const isSuperAdmin = req.user?.role === 'super_admin';
      const store = await StoreService.getById(id, { includeAcquisition: isSuperAdmin });

      // Mask marketing-pixel secrets (Meta CAPI / TikTok Events access tokens)
      // before the store object leaves the API. They're long-lived secrets the
      // admin UI must not display in plaintext; on save, masked values are
      // treated as "unchanged" (see PUT /marketing-pixels).
      const safeStore = store
        ? {
            ...toSafeStoreResponse(store),
            // Super-admin only: how the owner found Ebda. ip / user agent / Meta ids stay server-side.
            ...(isSuperAdmin
              ? { owner: { ...store.owner, acquisition: acquisitionForAdmin(store.owner) } }
              : {}),
          }
        : store;

      res.json({
        success: true,
        data: { store: safeStore },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:id/stats - Get store stats
router.get(
  '/:id/stats',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const stats = await StoreService.getStoreStats(id);

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /stores:
 *   post:
 *     summary: Create a new store
 *     description: Create a new store (admin only)
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 example: My Store
 *               slug:
 *                 type: string
 *                 pattern: ^[a-z0-9-]+$
 *                 example: my-store
 *               domain:
 *                 type: string
 *                 example: mystore.com
 *               settings:
 *                 type: object
 *     responses:
 *       201:
 *         description: Store created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     store:
 *                       $ref: '#/components/schemas/Store'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.post(
  '/',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parseStoreBody(createStoreSchema, req.body);
      const actor = getAuthUser(req);
      const isSuperAdmin = actor.role === 'super_admin';

      // A custom domain is claimed through PUT /:id/domain (pending until the
      // provider verifies ownership). Only a super_admin may set one here.
      if (!isSuperAdmin) delete data.domain;

      // A protected address granted by a super admin answers the merchant's open claim for it (before the grant, loud).
      if (isSuperAdmin) await closeClaimsOnSlugGrant(actor.userId, data.slug);
      const create = () =>
        StoreService.create(
          actor.userId,
          { ...data, settings: data.settings as Prisma.InputJsonValue },
          { allowProtectedSlug: isSuperAdmin, platformOperator: isSuperAdmin }
        );
      // Per-account daily cap (SP5 task 4), inside a per-owner lock.
      const store = isSuperAdmin
        ? await create()
        : await withStoreCreationLock(actor.userId, async () => {
            await assertStoreCreationBudget(actor.userId);
            return create();
          });

      res.status(201).json({
        success: true,
        data: { store: toSafeStoreResponse(store) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id - Update store (admin only)
router.put(
  '/:id',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = parseStoreBody(updateStoreSchema, req.body);
      const user = getAuthUser(req);

      // The time zone decides which day a sale / expense / VAT period belongs to (Ruling FRT-2), so
      // a change is filing-affecting: a period filed under the old zone no longer re-runs
      // identically. Read the stored value first so the audit row can say from what (issue 2432).
      // `stores` has RLS disabled (Ruling FRT-3), so the bare read needs no tenant context.
      const previousTimezone =
        data.timezone !== undefined
          ? ((await prisma.store.findUnique({ where: { id }, select: { timezone: true } }))
              ?.timezone ?? null)
          : null;

      // A custom domain is claimed through PUT /:id/domain (pending until the
      // provider verifies ownership). Only a super_admin may set one here.
      if (user.role !== 'super_admin') delete data.domain;

      if (user.role === 'super_admin') await closeClaimsOnSlugGrant(user.userId, data.slug);
      const store = await StoreService.update(
        id,
        { ...data, settings: data.settings as Prisma.InputJsonValue },
        { allowProtectedSlug: user.role === 'super_admin' }
      );

      if (data.timezone !== undefined && data.timezone !== previousTimezone) {
        await auditLog({
          action: 'STORE_TIMEZONE_CHANGED',
          userId: user.userId,
          storeId: id,
          resourceType: 'store',
          resourceId: id,
          details: { from: previousTimezone, to: data.timezone },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }

      res.json({
        success: true,
        data: { store: toSafeStoreResponse(store) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:id - Hard-delete a store and ALL its data (super_admin only).
// Cascade rules in the Prisma schema clean up most relations; the service
// transaction handles the few non-cascading ones (orders, returns, audit logs).
router.delete(
  '/:id',
  authenticate,
  requireMfaEnrolled,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const user = getAuthUser(req);

      const deleted = await StoreService.delete(id, user.userId);

      await auditLog({
        action: 'STORE_DELETED',
        userId: user.userId,
        resourceType: 'store',
        resourceId: id,
        details: { storeName: deleted.name, storeSlug: deleted.slug },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info({ storeId: id, deletedBy: user.userId }, '[STORE] Hard-deleted store');

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// `reason` (suspend only): what the merchant reads at GET /stores/:storeId/suspension (A13).
const storeStatusBody = z.object({
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(1).max(500).optional(),
});
const templateBody = z.object({ template: z.string().trim().min(1).max(40) });
const domainBody = z.object({ domain: z.string().max(253).nullable() });

// PATCH /stores/:id/status - Suspend or activate a store (super_admin only)
router.patch(
  '/:id/status',
  authenticate,
  requireMfaEnrolled,
  authorize('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // BE:S-15: a body that is not an object (or has a non-string status) is the same 400, not a TypeError.
      const parsedStatus = storeStatusBody.safeParse(req.body);
      if (!parsedStatus.success) {
        throw new AppError(400, 'INVALID_STATUS', 'Status must be active or suspended');
      }
      const status: StoreStatus = parsedStatus.data.status;

      // A13 ordering (Ruling TRUST-2). The Store row and the request notes cannot share one transaction: the Store is
      // written through D1 + its Durable Object, the notes through the platform D1 client. So the note write goes FIRST
      // and FAILS LOUD (no swallowed error): a suspension never lands without its reason row, and a reactivation never
      // lands with the appeal still open (which would block every future appeal through the one-open-appeal unique).
      // The failure modes left are harmless and self-healing on retry: an unused note on a store that never got
      // suspended (getSuspension answers 404 NOT_SUSPENDED), or an appeal closed on a store still suspended (the
      // merchant can file again).
      const storeId = req.params.id;
      const current = await withStore(storeId, tx =>
        tx.store.findUnique({ where: { id: storeId }, select: { status: true } })
      );
      if (!current) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
      await withStore(storeId, async tx => {
        const trustDb = tx as unknown as TrustDb;
        if (status === 'suspended') {
          await recordSuspension(
            trustDb,
            storeId,
            req.user!,
            parsedStatus.data.reason,
            String(current.status) === 'suspended'
          );
        } else {
          await closeAppealsOnReactivation(trustDb, storeId);
        }
      });

      // StoreService.setStatus owns the write AND the public-cache bust
      // (resolve/slug/id keys + storefront revalidate purge) — account
      // status is NEVER-stale, so the invalidation lives with the write
      // (adversarial audit P1-7; this handler used to bust only the feature
      // cache, leaving a suspended store serving the cached active resolve
      // — checkouts included — for up to the TTL).
      const store = await StoreService.setStatus(storeId, status as 'active' | 'suspended');

      // Invalidate the feature cache — store.status doesn't change the
      // resolved feature map directly, but downstream gates (storefront
      // 503, Inngest function skip) read it via the same Redis path on
      // the next request, so a clean cache reduces stale-state windows.
      await featureService.invalidateCache(req.params.id).catch(() => {});

      // Write an audit log entry so super-admin actions are traceable.
      // Two-tier visibility (2026-05-27): per-store entries (storeId = X)
      // are visible to that store's admins for their own team-action
      // trail; super-admin sees the cross-store trail.
      // insertAuditLog routes the row to the store's DO / D1 (the Worker has no Postgres) and never throws into the caller.
      await insertAuditLog({
        action: status === 'suspended' ? 'store.suspend' : 'store.reactivate',
        userId: req.user!.userId,
        storeId: req.params.id,
        resourceType: 'store',
        resourceId: req.params.id,
        details: {
          previousStatus: store.status === status ? 'unknown' : 'flipped',
          newStatus: status,
        },
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      }).catch(err => {
        // Don't fail the status change if audit log write fails.
        // Logged elsewhere; status change is the source of truth.
        logger.warn({ err, storeId: req.params.id }, '[store.status] audit log write failed');
      });

      res.json({ success: true, data: toSafeStoreResponse(store) });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:id/suspension/appeal/reject - Reject the open suspension appeal (super_admin only).
// Staff reply to the merchant by e-mail first; this records the decision, starts the merchant's 24 h cooldown
// (rejected_at) and leaves the store suspended. Reactivating (PATCH /:id/status) is the accept path.
router.post(
  '/:id/suspension/appeal/reject',
  authenticate,
  requireMfaEnrolled,
  authorize('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.id;
      const { id } = await withStore(storeId, tx =>
        rejectAppeal(tx as unknown as TrustDb, storeId)
      );
      await insertAuditLog({
        action: 'store.suspension_appeal_reject',
        userId: req.user!.userId,
        storeId,
        resourceType: 'trust_request',
        resourceId: id,
        details: {},
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.json({ success: true, data: { id, status: 'rejected' } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/template - Update store template
router.put(
  '/:id/template',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const parsedTemplate = templateBody.safeParse(req.body);
      if (
        !parsedTemplate.success &&
        typeof (req.body as { template?: unknown })?.template === 'string'
      ) {
        throw parsedTemplate.error; // present but too long / empty after trim: a 400 VALIDATION_ERROR
      }
      const template = parsedTemplate.success ? parsedTemplate.data.template : undefined;

      if (!template) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_TEMPLATE', message: 'Template is required' },
        });
        return;
      }

      const store = await StoreService.updateTemplate(id, template);

      res.json({
        success: true,
        data: { store: toSafeStoreResponse(store) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:id/look/preview - What applying a look would do, without doing it (Task 9)
router.post(
  '/:id/look/preview',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { lookId, design } = lookPreviewBody.parse(req.body);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ success: true, data: await StoreService.previewLook(id, lookId, { design }) });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/look - Apply a look (sets look + skin, re-shapes the home page)
router.put(
  '/:id/look',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { lookId, design, revisionToken } = lookBody.parse(req.body);
      const { store, builder } = await StoreService.applyLook(
        id,
        lookId,
        { design, revisionToken },
        getAuthUser(req).userId
      );
      res.json({
        success: true,
        data: { look: store.look, template: store.template, builder },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/theme - Update store theme
router.put(
  '/:id/theme',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const theme = themeSchema.parse(req.body);

      const store = await StoreService.updateTheme(id, theme as Record<string, unknown>);

      res.json({
        success: true,
        data: { store: toSafeStoreResponse(store) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/branding - Update store branding
router.put(
  '/:id/branding',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const branding = brandingSchema.parse(req.body);

      const store = await StoreService.updateBranding(id, branding);

      res.json({
        success: true,
        data: { store: toSafeStoreResponse(store) },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Merge a social-links body into the stored links. Keys the admin UI omits (e.g. `whatsapp`, which lives in the schema but has
 * no UI input) are never silently wiped on save. Only keys the client explicitly SENT (present in the raw body) are updated; a
 * sent empty value (mapped to undefined by `optionalUrl`) clears the stored value. Iterates the schema's STATIC key allowlist
 * (never user-controlled keys) so a crafted `{"__proto__": ...}` can't reach `merged[key]`; `hasOwnProperty`, not `in`.
 * Shared by `PUT /:id/social` and `PUT /:id/branding-bundle`.
 */
function socialLinksPatch(incoming: unknown, rawBody: unknown): SocialLinksPatch {
  const incomingRecord = incoming as Record<string, string | undefined>;
  const patch: SocialLinksPatch = { set: {}, remove: [] };
  for (const key of Object.keys(socialSchema.shape)) {
    if (!Object.prototype.hasOwnProperty.call(rawBody, key)) continue;
    const val = incomingRecord[key];
    if (val === undefined)
      patch.remove.push(key); // explicitly cleared (empty string -> remove)
    else patch.set[key] = val;
  }
  return patch;
}

// PUT /stores/:id/social - Update store social links
router.put(
  '/:id/social',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const incoming = socialSchema.parse(req.body);

      const store = await StoreService.patchSocialLinks(id, socialLinksPatch(incoming, req.body));

      res.json({
        success: true,
        data: { store: toSafeStoreResponse(store) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/branding-bundle - the branding page's Save as ONE request (BE:F-3).
//
// The page used to fire five independent PUTs (branding, theme, contact, social, settings). A 429 in the middle left the store
// half saved, with only a partial-failure toast. Every part here is optional and validated by the SAME schema as its own route.
// `StoreService.updateBrandingBundle` applies them in ONE database transaction on a Postgres store (any failure rolls all of it
// back); on a D1 + Durable Object store they are folded into ONE StoreDO `patchSettings` call applied in a single DO transaction
// (a refused part writes nothing; only the keys the page sends are merged, so a concurrent save of other keys survives).
// This router has NO request transaction (storeScopeContext), so the transaction is opened in the service, not here. `settings`
// goes through the key-wise merge of `PUT /:id` (server-owned keys never written), so the page sends only the keys it owns.
const brandingBundleSchema = z
  .object({
    branding: brandingSchema.optional(),
    theme: themeSchema.optional(),
    contact: contactSchema.optional(),
    social: socialSchema.optional(),
    settings: updateStoreSchema.shape.settings,
    blogEnabled: z.boolean().optional(),
  })
  .strict();

router.put(
  '/:id/branding-bundle',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const body = brandingBundleSchema.parse(req.body);
      const raw = (req.body ?? {}) as Record<string, unknown>;

      const store = await StoreService.updateBrandingBundle(id, {
        branding: body.branding,
        theme: body.theme as Record<string, unknown> | undefined,
        contact: body.contact,
        social: body.social ? socialLinksPatch(body.social, raw.social ?? {}) : undefined,
        settings: body.settings as Prisma.InputJsonValue | undefined,
        blogEnabled: body.blogEnabled,
      });
      res.json({ success: true, data: { store: toSafeStoreResponse(store) } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/contact - Update store contact info
router.put(
  '/:id/contact',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const contact = contactSchema.parse(req.body);

      const store = await StoreService.updateContactInfo(id, contact);

      res.json({
        success: true,
        data: { store: toSafeStoreResponse(store) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:id/announcement - Get store announcement bar settings
router.get(
  '/:id/announcement',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = await prisma.store.findFirst({
        where: { id: req.params.id },
        select: { announcementBar: true },
      });

      if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');

      res.json({ success: true, data: store.announcementBar ?? {} });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/announcement - Update store announcement bar
router.put(
  '/:id/announcement',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const announcementBar = announcementSchema.parse(req.body);

      const store = await StoreService.updateAnnouncementBar(id, announcementBar);

      res.json({
        success: true,
        data: { store: toSafeStoreResponse(store) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/floating-widget — dedicated writer for the storefront's
// floating action-button widget. Lives on Store.settings.floatingWidget;
// the merge happens server-side in StoreService.updateFloatingWidget so
// the admin only ships the widget config, not the whole settings blob
// (which is fragile across tabs and silently drops fields if the admin
// holds a stale copy).
router.put(
  '/:id/floating-widget',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // floating_widget is Enterprise-only. Without this gate a non-Enterprise
  // merchant could persist a fully-configured widget for free — it would go
  // live instantly on plan upgrade with no further merchant action. Matches
  // the existing marketing_pixels gate below for consistency.
  requireFeature('floating_widget'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const floatingWidget = floatingWidgetSchema.parse(req.body);

      const store = await StoreService.updateFloatingWidget(
        id,
        floatingWidget as Record<string, unknown>
      );

      res.json({
        success: true,
        data: { store: toSafeStoreResponse(store) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:id/seo - Get store SEO settings
router.get(
  '/:id/seo',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = await prisma.store.findFirst({
        where: { id: req.params.id },
        select: {
          metaTitle: true,
          metaTitleAr: true,
          metaDescription: true,
          metaDescriptionAr: true,
          metaDescriptionAeo: true,
          metaDescriptionAeoAr: true,
          ogImage: true,
          twitterHandle: true,
          googleSiteVerification: true,
          emailSenderLocalPart: true,
          settings: true,
        },
      });

      if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');

      const { settings, ...seoFields } = store;
      res.json({
        success: true,
        data: toSafeStoreResponse({
          ...seoFields,
          hideFromSearchEngines:
            (settings as Record<string, unknown> | null)?.hideFromSearchEngines === true,
        }),
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/seo - Update store SEO settings
router.put(
  '/:id/seo',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // BE:S-9: the `seo` feature (Starter+) gates the write on the server, not only the page. Deletes stay open so a downgraded store can clean up.
  requireFeature('seo'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const seo = seoSchema.parse(req.body);

      const store = await StoreService.updateSeo(id, seo);

      res.json({
        success: true,
        data: { store: toSafeStoreResponse(store) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/marketing-pixels - Update store marketing pixels
router.put(
  '/:id/marketing-pixels',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('marketing_pixels'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { marketingPixels } = z
        .object({ marketingPixels: marketingPixelsSchema })
        .parse(req.body);

      // Masked-secret resubmit guard: if the admin saves without editing a
      // token field, the UI sends back the masked value (`EAAB****wXyz`).
      // Treat any value still carrying the `****` sentinel as "unchanged" and
      // keep the real stored token rather than overwriting it with mask text.
      const current = await prisma.store.findUnique({
        where: { id },
        select: { marketingPixels: true },
      });
      const merged = preserveMaskedPixelSecrets(marketingPixels, current?.marketingPixels);

      const store = await StoreService.updateMarketingPixels(id, merged as Prisma.InputJsonValue);

      // Mask secrets again on the way back out so the response can't leak the
      // freshly-stored token.
      const safeStore = toSafeStoreResponse(store);

      res.json({
        success: true,
        data: { store: safeStore },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:id/domain - Get domain verification status
router.get(
  '/:id/domain',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const domainSvc0 = resolveDomainService();
      // A pending claim is re-checked against the provider on every status
      // read: the moment DCV passes it is promoted to the store's domain, so the
      // merchant never waits for the next sweep tick.
      await DomainClaimService.sync(id, domainSvc0).catch(err =>
        logger.warn({ err, storeId: id }, 'Domain claim sync failed during GET /domain')
      );
      await StoreService.getById(id); // 404s an unknown store
      const storeRow = await prisma.store.findUnique({
        where: { id },
        select: {
          domain: true,
          pendingDomain: true,
          domainStatus: true,
          domainClaimedAt: true,
          emailDomainId: true,
          emailDomainStatus: true,
          emailDomainVerifiedAt: true,
          domainProvider: true,
        },
      });
      // The hostname the merchant is working with: the unverified claim if any,
      // else the verified domain. (`store.domain` is verified-only.)
      const shownDomain = storeRow?.pendingDomain ?? storeRow?.domain ?? null;

      // No custom domain at all — neither the provider nor Resend state is meaningful.
      if (!shownDomain) {
        res.json({
          success: true,
          data: {
            domain: null,
            verified: false,
            claimStatus: null,
            dnsRecords: [],
            emailSender: {
              domainId: storeRow?.emailDomainId ?? null,
              status: storeRow?.emailDomainStatus ?? null,
              verifiedAt: storeRow?.emailDomainVerifiedAt ?? null,
            },
          },
        });
        return;
      }

      // Resolve the frontend host provider for THIS store (Cloudflare-for-SaaS
      // is the only provider; `resolveDomainService` still takes the store's
      // row for signature compat with legacy callers).
      const domainSvc = resolveDomainService({ domainProvider: storeRow?.domainProvider });
      const providerStatus = await domainSvc.getDomain(shownDomain);

      // Mail is sent from ebda.app by Cloudflare Email Service (G6): a merchant domain has no email
      // DNS records of its own; the stored email-domain fields are legacy and shown as stored.
      const resendRecords: Array<{
        type: string;
        name: string;
        value: string;
        priority?: number;
        ttl?: string;
      }> = [];
      const liveEmailStatus: string | null = storeRow?.emailDomainStatus ?? null;
      const liveEmailVerifiedAt: Date | null = storeRow?.emailDomainVerifiedAt ?? null;

      // Merge provider DNS records into one panel. The admin renders
      // this list under a neutral 'DNS records to add at your registrar'
      // heading so merchants never see provider names. The fallback when the
      // provider API is unreachable is a single CNAME to the Cloudflare-for-SaaS
      // zone target (www handling is automatic on the Cloudflare side).
      const providerFallbackRecords = fallbackDnsRecords(shownDomain);
      const providerRecords = providerStatus?.dnsRecords ?? providerFallbackRecords;
      const mergedDns = [...providerRecords, ...resendRecords];

      res.json({
        success: true,
        data: {
          ...(providerStatus ?? {
            domain: shownDomain,
            verified: false,
            misconfigured: true,
          }),
          // pending | active | failed — a pending/failed claim is not served and
          // is released after DOMAIN_CLAIM_TTL_HOURS (72h) from `claimedAt`.
          claimStatus: storeRow?.domainStatus ?? null,
          claimedAt: storeRow?.domainClaimedAt ?? null,
          dnsRecords: mergedDns,
          emailSender: {
            domainId: storeRow?.emailDomainId ?? null,
            status: liveEmailStatus,
            verifiedAt: liveEmailVerifiedAt,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/domain - Claim (or clear) the store's custom domain.
//
// Setting a domain makes a CLAIM, not an active domain: it is stored as
// `pendingDomain` and is not served (host resolution, credentialed CORS and
// `storefrontOrigin` read only the verified `domain`) until the provider
// (Cloudflare for SaaS) reports the hostname verified. A pending claim older
// than DOMAIN_CLAIM_TTL_HOURS (72h) is released by the sweep. A domain ACTIVE on
// another store can never be claimed. See services/domain-claim.service.ts.
router.put(
  '/:id/domain',
  authenticate,
  requireMfaEnrolled,
  // BE:S-2 (Ruling FP-3): repointing the live domain is not an impersonation action.
  rejectImpersonated,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      // BE:S-14: `domain` must be PRESENT (string or null). A body without it used to clear the live verified domain and its
      // Cloudflare hostname; clearing is now an explicit `{ "domain": null }` (or "").
      const { domain: rawDomain } = domainBody.parse(req.body);

      let domain: string | null;
      let claimState: 'pending' | 'active' | null;
      let domainSvc: DomainProvider;
      try {
        // Normalize (lowercase, strip www, trim), refuse Ebda's own hosts, then claim / keep / clear (services/store-domain.service.ts).
        ({ domain, claimState, provider: domainSvc } = await setStoreDomain(id, rawDomain));
      } catch (err) {
        if (!(err instanceof DomainChangeError)) throw err;
        res
          .status(err.status)
          .json({ success: false, error: { code: err.code, message: err.message } });
        return;
      }
      const updated = await prisma.store.findUnique({
        where: { id },
        include: { owner: { select: { id: true, email: true, firstName: true, lastName: true } } },
      });

      // Verification status of what the merchant just saved (the claim if any).
      const shown = domain;
      let domainStatus: import('../services/domain-provider').DomainStatus | null = null;
      if (shown) domainStatus = await domainSvc.getDomain(shown);

      res.json({
        success: true,
        data: {
          store: updated,
          claim: claimState ? { state: claimState, domain: shown } : null,
          domainStatus:
            domainStatus ||
            (shown
              ? {
                  domain: shown,
                  verified: false,
                  misconfigured: true,
                  dnsRecords: fallbackDnsRecords(shown),
                }
              : null),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:id/email-sender/provision and /verify: retired with Resend (G6). Mail is sent from
// ebda.app by Cloudflare Email Service, so a merchant domain needs no email DNS records. The routes
// stay so an older admin build gets a clean, empty answer instead of a 404.
const retiredEmailSender = [
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  (_req: Request, res: Response) => {
    res.json({ success: true, data: { status: 'unsupported', records: [] } });
  },
];
router.post('/:id/email-sender/provision', ...retiredEmailSender);
router.post('/:id/email-sender/verify', ...retiredEmailSender);

// ===== Store FAQ CRUD =====

const faqSchema = z.object({
  question: z.string().min(1).max(500),
  questionAr: z.string().max(500).optional().nullable(),
  answer: z.string().min(1).max(5000),
  answerAr: z.string().max(5000).optional().nullable(),
  orderIndex: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

router.get(
  '/:id/faqs',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // store_faqs / store_howtos have STRICT RLS policies; this router is
  // context-less (routes/index.ts), so set the store's context per route.
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const faqs = await (
        await storeDb(currentStoreId())
      ).storeFaq.findMany({
        where: { storeId: req.params.id },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      });
      res.json({ success: true, data: faqs });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/faqs',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // BE:S-9: the `seo` feature (Starter+) gates the write on the server, not only the page. Deletes stay open so a downgraded store can clean up.
  requireFeature('seo'),
  // store_faqs / store_howtos have STRICT RLS policies; this router is
  // context-less (routes/index.ts), so set the store's context per route.
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = faqSchema.parse(req.body);
      const faq = await StoreFaqService.create(req.params.id, body);
      res.status(201).json({ success: true, data: faq });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/:id/faqs/:faqId',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // BE:S-9: the `seo` feature (Starter+) gates the write on the server, not only the page. Deletes stay open so a downgraded store can clean up.
  requireFeature('seo'),
  // store_faqs / store_howtos have STRICT RLS policies; this router is
  // context-less (routes/index.ts), so set the store's context per route.
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = faqSchema.partial().parse(req.body);
      const updated = await StoreFaqService.update(req.params.id, req.params.faqId, body);
      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id/faqs/:faqId',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // store_faqs / store_howtos have STRICT RLS policies; this router is
  // context-less (routes/index.ts), so set the store's context per route.
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deleted = await (
        await storeWriter(currentStoreId())
      ).storeFaq.deleteMany({
        where: { id: req.params.faqId, storeId: req.params.id },
      });
      if (deleted.count === 0) {
        throw new AppError(404, 'NOT_FOUND', 'FAQ not found');
      }
      res.json({ success: true, data: { message: 'FAQ deleted' } });
    } catch (error) {
      next(error);
    }
  }
);

// ===== Store HowTo CRUD =====

const howtoStepSchema = z.object({
  name: z.string().min(1).max(200),
  text: z.string().min(1).max(2000),
  image: z.string().url().optional(),
});

const howtoSchema = z.object({
  title: z.string().min(1).max(200),
  titleAr: z.string().max(200).optional().nullable(),
  description: z.string().min(1).max(2000),
  descriptionAr: z.string().max(2000).optional().nullable(),
  steps: z.array(howtoStepSchema).min(1).max(20),
  stepsAr: z.array(howtoStepSchema).optional().nullable(),
  orderIndex: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

router.get(
  '/:id/howtos',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // store_faqs / store_howtos have STRICT RLS policies; this router is
  // context-less (routes/index.ts), so set the store's context per route.
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const howtos = await (
        await storeDb(currentStoreId())
      ).storeHowto.findMany({
        where: { storeId: req.params.id },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      });
      res.json({ success: true, data: howtos });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/howtos',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // BE:S-9: the `seo` feature (Starter+) gates the write on the server, not only the page. Deletes stay open so a downgraded store can clean up.
  requireFeature('seo'),
  // store_faqs / store_howtos have STRICT RLS policies; this router is
  // context-less (routes/index.ts), so set the store's context per route.
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = howtoSchema.parse(req.body);
      const howto = await (
        await storeWriter(currentStoreId())
      ).storeHowto.create({
        data: {
          storeId: req.params.id,
          title: body.title,
          titleAr: body.titleAr ?? null,
          description: body.description,
          descriptionAr: body.descriptionAr ?? null,
          steps: body.steps as Prisma.InputJsonValue,
          stepsAr: body.stepsAr != null ? (body.stepsAr as Prisma.InputJsonValue) : Prisma.DbNull,
          orderIndex: body.orderIndex ?? 0,
          isActive: body.isActive ?? true,
          aiDrafted: false,
          manuallyEdited: true,
        },
      });
      res.status(201).json({ success: true, data: howto });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/:id/howtos/:howtoId',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // BE:S-9: the `seo` feature (Starter+) gates the write on the server, not only the page. Deletes stay open so a downgraded store can clean up.
  requireFeature('seo'),
  // store_faqs / store_howtos have STRICT RLS policies; this router is
  // context-less (routes/index.ts), so set the store's context per route.
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = howtoSchema.partial().parse(req.body);
      // Verify ownership before update
      const existing = await (
        await storeDb(currentStoreId())
      ).storeHowto.findFirst({
        where: { id: req.params.howtoId, storeId: req.params.id },
        select: { id: true },
      });
      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', 'HowTo not found');
      }
      const updateData: Prisma.StoreHowtoUpdateInput = { manuallyEdited: true };
      if (body.title !== undefined) updateData.title = body.title;
      if (body.titleAr !== undefined) updateData.titleAr = body.titleAr;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.descriptionAr !== undefined) updateData.descriptionAr = body.descriptionAr;
      if (body.steps !== undefined) updateData.steps = body.steps as Prisma.InputJsonValue;
      if (body.stepsAr !== undefined) {
        updateData.stepsAr =
          body.stepsAr != null ? (body.stepsAr as Prisma.InputJsonValue) : Prisma.DbNull;
      }
      if (body.orderIndex !== undefined) updateData.orderIndex = body.orderIndex;
      if (body.isActive !== undefined) updateData.isActive = body.isActive;
      const updated = await (
        await storeWriter(currentStoreId())
      ).storeHowto.update({
        where: { id: req.params.howtoId, storeId: req.params.id },
        data: updateData,
      });
      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id/howtos/:howtoId',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // store_faqs / store_howtos have STRICT RLS policies; this router is
  // context-less (routes/index.ts), so set the store's context per route.
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deleted = await (
        await storeWriter(currentStoreId())
      ).storeHowto.deleteMany({
        where: { id: req.params.howtoId, storeId: req.params.id },
      });
      if (deleted.count === 0) {
        throw new AppError(404, 'NOT_FOUND', 'HowTo not found');
      }
      res.json({ success: true, data: { message: 'HowTo deleted' } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
