import { prisma } from '@force/database';
import { isCampaignContentComplete, storefrontOrigin } from '@force/shared';
import { sanitizeNewsletterHtml } from '../lib/email-html-sanitizer';
import { renderBrandedShell } from './email.service';

/**
 * Email campaigns (D2) — the pieces the admin routes, the Inngest send job and
 * the public unsubscribe endpoint share. Plan: docs/plans/2026-09-25-email-campaigns.md.
 *
 * Nothing in this module sends email. Sending happens only in
 * `lib/inngest/functions/campaign-send.ts`, which only runs after a merchant
 * presses send (or the test-send route, which only ever mails the merchant).
 */

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
 */
export function campaignDailyCap(): number {
  return positiveIntEnv('CAMPAIGN_DAILY_SEND_CAP', 1000);
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

/** Campaign emails this store actually sent in the last 24h. `sentAt` is set
 *  only on a successful send and survives a later unsubscribe, so a recipient
 *  who unsubscribed still counts against the window it was sent in.
 *
 *  The count reads `campaign_recipients` rows, so no path may DELETE a sent
 *  row inside the window — that hands the store back cap headroom on the one
 *  shared Resend key. The DELETE route refuses (#1951); account erasure
 *  anonymizes those rows instead of deleting them (issue 2083,
 *  `AuthService.eraseAccount`). A new deleter must do the same. */
export async function sentInLast24h(storeId: string, now: Date = new Date()): Promise<number> {
  return prisma.campaignRecipient.count({
    where: { storeId, sentAt: { gte: new Date(now.getTime() - SEND_CAP_WINDOW_MS) } },
  });
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
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT LOWER(TRIM(email))) AS count
    FROM newsletter_subscribers
    WHERE store_id = ${storeId}
      AND is_active = true
      AND unsubscribed_at IS NULL
      AND email LIKE '%@%'
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function buildCampaignAudience(storeId: string): Promise<AudienceMember[]> {
  const rows = await prisma.newsletterSubscriber.findMany({
    where: { storeId, isActive: true, unsubscribedAt: null },
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
  settings: true,
  slug: true,
  domain: true,
  emailSenderLocalPart: true,
  emailDomainStatus: true,
} as const;

export function storeDefaultLanguage(store: { settings: unknown }): 'en' | 'ar' {
  const s = store.settings as Record<string, unknown> | null;
  return s?.defaultLanguage === 'ar' ? 'ar' : 'en';
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
}): { subject: string; html: string } {
  const { store, locale } = args;
  const storeName = escapeHtml(locale === 'ar' && store.nameAr ? store.nameAr : store.name);
  const href = args.unsubscribeUrl ? escapeHtml(args.unsubscribeUrl) : '#';
  const footer =
    locale === 'ar'
      ? `<p style="margin-top:28px;font-size:12px;color:#94a3b8;text-align:center;">وصلتك هذه الرسالة لأنك مشترك في النشرة البريدية لـ ${storeName}. <a href="${href}" style="color:#94a3b8;">إلغاء الاشتراك</a></p>`
      : `<p style="margin-top:28px;font-size:12px;color:#94a3b8;text-align:center;">You are receiving this because you subscribed to ${storeName}'s newsletter. <a href="${href}" style="color:#94a3b8;">Unsubscribe</a></p>`;

  const html = renderBrandedShell(sanitizeNewsletterHtml(args.bodyHtml) + footer, {
    name: store.name,
    nameAr: store.nameAr,
    logo: store.logo,
    email: store.email,
    phone: store.phone,
    address: store.address,
    theme: store.theme as { primaryColor?: string | null; primary?: string | null } | null,
    defaultLanguage: locale,
  });
  return { subject: sanitizeSubject(args.subject), html };
}
