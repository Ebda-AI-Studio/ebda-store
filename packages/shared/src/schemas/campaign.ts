import { z } from 'zod/v3';

/**
 * Email campaigns (D2, 2026-09-25) — the request contracts shared by the API
 * (`apps/api/src/routes/campaign.routes.ts`) and the admin editor
 * (`apps/admin/src/app/stores/[id]/campaigns`). Plan:
 * docs/plans/done/2026-09-25-email-campaigns.md.
 */

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'cancelled',
  'failed',
] as const;
export type CampaignStatusValue = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_RECIPIENT_STATUSES = [
  'queued',
  'sent',
  'failed',
  'bounced',
  'unsubscribed',
] as const;
export type CampaignRecipientStatusValue = (typeof CAMPAIGN_RECIPIENT_STATUSES)[number];

/**
 * `subscriber` = each recipient's newsletter signup language, else the store
 * default. `en` / `ar` = everyone gets that language. Whichever language is
 * chosen, a campaign missing that language's content falls back to the other.
 */
export const CAMPAIGN_LOCALE_STRATEGIES = ['subscriber', 'en', 'ar'] as const;
export type CampaignLocaleStrategy = (typeof CAMPAIGN_LOCALE_STRATEGIES)[number];

/** Upper bound on a campaign body. Generous for hand-written HTML, small
 *  enough that one row cannot bloat a request or an email past Gmail's
 *  ~102KB clipping threshold by much. */
export const CAMPAIGN_BODY_MAX = 100_000;
export const CAMPAIGN_SUBJECT_MAX = 200;
export const CAMPAIGN_NAME_MAX = 120;

/**
 * Who a campaign goes to. The only source is the store's own newsletter list:
 * active subscribers who opted in, deduped by lowercased email. There is no
 * "all customers" source on purpose — customers have no email-marketing
 * consent flag (Ruling EC-1, docs/RULINGS.md).
 */
export const campaignAudienceSchema = z.object({ source: z.literal('newsletter') }).strict();
export type CampaignAudience = z.infer<typeof campaignAudienceSchema>;

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform(v => (v == null ? null : v));

/**
 * Create / update body. Content may be incomplete while it is a draft; the
 * send endpoint checks `isCampaignContentComplete` before anything is queued.
 */
export const campaignDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(CAMPAIGN_NAME_MAX),
    subject: z.string().trim().max(CAMPAIGN_SUBJECT_MAX).default(''),
    subjectAr: optionalText(CAMPAIGN_SUBJECT_MAX),
    bodyHtml: z.string().max(CAMPAIGN_BODY_MAX).default(''),
    bodyHtmlAr: optionalText(CAMPAIGN_BODY_MAX),
    localeStrategy: z.enum(CAMPAIGN_LOCALE_STRATEGIES).default('subscriber'),
    audience: campaignAudienceSchema.default({ source: 'newsletter' }),
  })
  .strict();
export type CampaignDraftInput = z.infer<typeof campaignDraftSchema>;

/** Send now (no `scheduledAt`) or schedule. The API additionally requires a
 *  schedule to be in the future and at most 30 days out. */
export const campaignSendSchema = z
  .object({
    scheduledAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type CampaignSendInput = z.infer<typeof campaignSendSchema>;

export const CAMPAIGN_MAX_SCHEDULE_DAYS = 30;

/** "AI draft" — the merchant describes the email; Gemini writes EN + AR. */
export const campaignAiDraftSchema = z
  .object({
    brief: z.string().trim().min(3).max(500),
  })
  .strict();
export type CampaignAiDraftInput = z.infer<typeof campaignAiDraftSchema>;

interface CampaignContentShape {
  subject?: string | null;
  subjectAr?: string | null;
  bodyHtml?: string | null;
  bodyHtmlAr?: string | null;
}

/** True when the given language has BOTH a subject and a body. */
export function isCampaignContentComplete(c: CampaignContentShape, lang: 'en' | 'ar'): boolean {
  const subject = lang === 'ar' ? c.subjectAr : c.subject;
  const body = lang === 'ar' ? c.bodyHtmlAr : c.bodyHtml;
  return !!subject?.trim() && !!body?.trim();
}

/** A campaign can be sent when at least one language is complete. */
export function isCampaignSendable(c: CampaignContentShape): boolean {
  return isCampaignContentComplete(c, 'en') || isCampaignContentComplete(c, 'ar');
}
