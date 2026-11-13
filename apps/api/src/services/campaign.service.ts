import { prisma, withStore, runInTenantContext } from '@ebda/database';
import { storeDb, storeRepo, type StoreReads, type StoreWrites } from '../lib/repo-factory';
import { isCampaignContentComplete, resolveDefaultLanguage, storefrontOrigin } from '@ebda/shared';
import { sanitizeNewsletterHtml } from '../lib/email-html-sanitizer';
import { renderBrandedShell } from './email.service';
import { storeBrandTheme } from '../lib/store-brand-theme';

/**
 * Email campaigns (D2) — the pieces the admin routes, the Inngest send job and
 * the public unsubscribe endpoint share. Plan: docs/plans/done/2026-09-25-email-campaigns.md.
 *
 * Nothing in this module sends email. Sending happens only in
 * `lib/inngest/functions/campaign-send.ts`, which only runs after a merchant
 * presses send (or the test-send route, which only ever mails the merchant).
 */

/**
 * One store's campaign reads and writes for a job step or a public endpoint (Ruling CF-R6A-2). A store on Postgres keeps
 * its request-style tenant scope (`runInTenantContext`, unchanged); a store on its Durable Object has no Postgres scope to
 * open, its `campaigns` / `campaign_recipients` / newsletter rows come over RPC.
 */
export async function inCampaignStore<T>(
  storeId: string,
  fn: (db: StoreReads, w: StoreWrites) => Promise<T>
): Promise<T> {
  const repo = await storeRepo(storeId);
  const run = () => fn(repo.db, repo.writer);
  return repo.backend === 'do' ? run() : runInTenantContext(storeId, run);
}

// ─── Limits (docs/ENVIRONMENT.md) ────────────────────────────────────────────

function positiveIntEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Per-store cap on campaign emails sent in any rolling 24 hours. Protects the
 * platform's shared Resend sender reputation: one store blasting a stale list
 * degrades deliverability for every store on the platform-domain fallback
 * sender. Test sends do not count.
 *
 * Per plan (Ruling CAMP-PLAN-2): `store.plan` (the plan's feature tier) picks
 * the default - Growth/professional 1000, Business/enterprise 5000, any other
 * tier (reachable only via a super-admin override) 500. No plan = the old
 * flat 1000. An explicit `CAMPAIGN_DAILY_SEND_CAP` is the ops override and
 * applies to every plan.
 */
export const CAMPAIGN_DAILY_CAP_BY_PLAN: Record<string, number> = {
  professional: 1000,
  enterprise: 5000,
};

export function campaignDailyCap(plan?: string | null): number {
  const fallback = plan ? (CAMPAIGN_DAILY_CAP_BY_PLAN[plan] ?? 500) : 1000;
  return positiveIntEnv('CAMPAIGN_DAILY_SEND_CAP', fallback);
}

/** The cap for one store, reading its plan tier in the store's own scope. */
export async function storeCampaignDailyCap(storeId: string): Promise<number> {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select: { plan: true } })
  );
  return campaignDailyCap(store?.plan);
}

/**
 * Pause after each SUCCESSFUL send (the bulk-AI sleep-after-success pattern,
 * not retry-on-429). Resend's default limit is 2 requests/second per API key
 * and that key is shared with every transactional email on the platform, so
 * the default (1000ms → ~60/min) leaves half the budget to order emails.
 * This is PER STORE; the combined rate across stores sending at once is
 * bounded by `lib/campaign-send-pacer.ts` (#1955).
 */
export function campaignThrottleMs(): number {
  const n = parseInt(process.env.CAMPAIGN_SEND_THROTTLE_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

/** The rolling send-cap window. Exported so every deleter of recipient rows
 *  can keep the rows this window still counts (see `sentInLast24h`). */
export const SEND_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Campaign + cart-recovery emails this store actually sent in the last 24h. `sentAt` is set
 *  only on a successful send and survives a later unsubscribe, so a recipient
 *  who unsubscribed still counts against the window it was sent in.
 *
 *  The count reads `campaign_recipients` rows, so no path may DELETE a sent
 *  row inside the window — that hands the store back cap headroom on the one
 *  shared Resend key. The DELETE route refuses (#1951); account erasure
 *  anonymizes those rows instead of deleting them (issue 2083,
 *  `AuthService.eraseAccount`). A new deleter must do the same. */
export async function sentInLast24h(storeId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - SEND_CAP_WINDOW_MS);
  // Cart-recovery emails go out through the same Resend key and sender reputation, so they spend
  // the same rolling 24h budget (Ruling CART-EMAIL-6).
  // A DO store counts its own rows (the same two counts); a Postgres store reads through the ambient scope as before.
  const db = await storeDb(storeId);
  const [campaign, cart] = await Promise.all([
    db.campaignRecipient.count({ where: { storeId, sentAt: { gte: since } } }),
    db.abandonedCart.count({ where: { storeId, emailSentAt: { gte: since } } }),
  ]);
  return campaign + cart;
}

// ─── Audience (consent) ──────────────────────────────────────────────────────

export interface AudienceMember {
  email: string;
  subscriberId: string;
  language: 'en' | 'ar' | null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Everyone a campaign for this store may go to: ACTIVE newsletter subscribers
 * of THIS store who have not unsubscribed, deduped by lowercased email.
 *
 * The consent rule lives in the `where` below and nowhere else. Customers are
 * deliberately NOT a source: the schema has no email-marketing consent flag
 * for them (Order.smsOptIn is SMS-only), and "they bought once" is not consent
 * (Ruling EC-1). `storeId` is filtered explicitly as well as by RLS, because
 * production connects as a BYPASSRLS role.
 */
/**
 * The SIZE of `buildCampaignAudience`'s result, without loading every row.
 * #1953: `GET /campaigns/audience` and the `/send` pre-check both called
 * `buildCampaignAudience` and used only `.length`, so every subscriber row
 * (email/id/language) was fetched and JS-deduped just to answer a count.
 *
 * Not a bare `prisma.newsletterSubscriber.count(...)`: `@@unique([storeId,
 * email])` is on the RAW string, not a normalized one, so two rows can exist
 * for the same address in different casing/whitespace (the reason
 * `buildCampaignAudience` dedupes with `normalizeEmail` in JS) — a plain
 * count would overcount that case. This mirrors the exact same reachable
 * definition (normalized non-empty email, deduped) in one raw aggregate
 * instead of materializing every row.
 */
export async function audienceCount(storeId: string): Promise<number> {
  // A store on its Durable Object counts the same reachable set from its own rows (Ruling CF-R4-4): the raw aggregate below
  // is Postgres SQL. Same definition by construction, because it IS `buildCampaignAudience`.
  if ((await storeRepo(storeId)).backend === 'do')
    return (await buildCampaignAudience(storeId)).length;
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT LOWER(TRIM(email))) AS count
    FROM newsletter_subscribers
    WHERE store_id = ${storeId}
      AND is_active = true
      AND unsubscribed_at IS NULL
      AND consent_scope <> 'cart_reminders'
      AND email LIKE '%@%'
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function buildCampaignAudience(storeId: string): Promise<AudienceMember[]> {
  const rows = await (
    await storeDb(storeId)
  ).newsletterSubscriber.findMany({
    // 'cart_reminders' (the checkout box) is consent for cart reminders ONLY, never campaigns.
    where: {
      storeId,
      isActive: true,
      unsubscribedAt: null,
      consentScope: { not: 'cart_reminders' },
    },
    select: { id: true, email: true, language: true },
    orderBy: { subscribedAt: 'asc' },
  });

  const seen = new Set<string>();
  const out: AudienceMember[] = [];
  for (const row of rows) {
    const email = normalizeEmail(row.email ?? '');
    if (!email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    out.push({
      email,
      subscriberId: row.id,
      language: row.language === 'ar' ? 'ar' : row.language === 'en' ? 'en' : null,
    });
  }
  return out;
}

// ─── Content ─────────────────────────────────────────────────────────────────

export function resolveRecipientLocale(
  strategy: string,
  memberLanguage: 'en' | 'ar' | null,
  storeDefault: 'en' | 'ar'
): 'en' | 'ar' {
  if (strategy === 'en' || strategy === 'ar') return strategy;
  return memberLanguage ?? storeDefault;
}

export interface CampaignContent {
  subject: string;
  subjectAr: string | null;
  bodyHtml: string;
  bodyHtmlAr: string | null;
}

/** The subject + body for one locale, falling back to the other language when
 *  the requested one is incomplete. `locale` is the language actually used. */
export function pickCampaignContent(
  c: CampaignContent,
  wanted: 'en' | 'ar'
): { locale: 'en' | 'ar'; subject: string; bodyHtml: string } {
  const other: 'en' | 'ar' = wanted === 'ar' ? 'en' : 'ar';
  const locale = isCampaignContentComplete(c, wanted) ? wanted : other;
  return locale === 'ar'
    ? { locale, subject: (c.subjectAr ?? '').trim(), bodyHtml: c.bodyHtmlAr ?? '' }
    : { locale, subject: c.subject.trim(), bodyHtml: c.bodyHtml };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Subject lines are a header: strip CR/LF/control characters so a stored
 *  subject can never inject a second header line. */
export function sanitizeSubject(subject: string): string {
  return subject.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim();
}

export interface CampaignStoreContext {
  id: string;
  name: string;
  nameAr: string | null;
  logo: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  theme: unknown;
  look?: string | null;
  template?: string | null;
  settings: unknown;
  slug: string;
  domain: string | null;
  emailSenderLocalPart: string | null;
  emailDomainStatus: string | null;
}

export const CAMPAIGN_STORE_SELECT = {
  id: true,
  name: true,
  nameAr: true,
  logo: true,
  email: true,
  phone: true,
  address: true,
  theme: true,
  look: true,
  template: true,
  settings: true,
  slug: true,
  domain: true,
  emailSenderLocalPart: true,
  emailDomainStatus: true,
} as const;

export function storeDefaultLanguage(store: { settings: unknown }): 'en' | 'ar' {
  const s = store.settings as Record<string, unknown> | null;
  return resolveDefaultLanguage(s?.defaultLanguage);
}

/** Same base-URL rule the review-request email uses for its deep links. */
export function storefrontBaseUrl(store: { domain: string | null; slug: string }): string {
  return storefrontOrigin(store);
}

/**
 * RFC 8058 one-click unsubscribe headers. Built only from our own API origin
 * and our own signed token — no merchant- or subscriber-controlled string
 * reaches a header. Omitted when API_URL is not https (a local/dev value would
 * advertise an unreachable URL to every mailbox provider).
 */
export function listUnsubscribeHeaders(
  apiUrl: string,
  token: string
): Record<string, string> | undefined {
  if (!/^https:\/\/[^\s/]+/i.test(apiUrl)) return undefined;
  const url = `${apiUrl.replace(/\/+$/, '')}/api/v1/public/campaigns/unsubscribe?token=${encodeURIComponent(token)}`;
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * Render one campaign email: sanitized body + a bilingual-aware unsubscribe
 * footer, inside the store's branded shell. `unsubscribeUrl` null renders the
 * footer text without a live link (test sends have no recipient row).
 */
export function renderCampaignEmail(args: {
  store: CampaignStoreContext;
  locale: 'en' | 'ar';
  subject: string;
  bodyHtml: string;
  unsubscribeUrl: string | null;
  /** Drop the "Powered by Ebda" line (resolve with `storeHidesPoweredBy`). */
  hidePoweredBy?: boolean;
}): { subject: string; html: string } {
  const { store, locale } = args;
  const storeName = escapeHtml(locale === 'ar' && store.nameAr ? store.nameAr : store.name);
  const href = args.unsubscribeUrl ? escapeHtml(args.unsubscribeUrl) : '#';
  const footer =
    locale === 'ar'
      ? `<p style="margin-top:28px;font-size:12px;color:#94a3b8;text-align:center;">وصلتك الرسالة دي عشان إنت مشترك في النشرة البريدية لـ ${storeName}. <a href="${href}" style="color:#94a3b8;">إلغاء الاشتراك</a></p>`
      : `<p style="margin-top:28px;font-size:12px;color:#94a3b8;text-align:center;">You are receiving this because you subscribed to ${storeName}'s newsletter. <a href="${href}" style="color:#94a3b8;">Unsubscribe</a></p>`;

  const html = renderBrandedShell(sanitizeNewsletterHtml(args.bodyHtml) + footer, {
    name: store.name,
    nameAr: store.nameAr,
    logo: store.logo,
    email: store.email,
    phone: store.phone,
    address: store.address,
    // A look store's brand colour is the look's unless the merchant stored one (LOOKS-14).
    theme: storeBrandTheme(store) as {
      primaryColor?: string | null;
      primary?: string | null;
    } | null,
    defaultLanguage: locale,
    hidePoweredBy: args.hidePoweredBy,
  });
  return { subject: sanitizeSubject(args.subject), html };
}
