/**
 * Phase E3 (plan 4 E*): messaging and customer-value tools. Declared with `change()` from ./kit (money in tool arguments is EGP, decimal, converted with
 * Math.round(x * 100)); the reads are `free` ToolSpecs gated by the same role + plan feature as the screen's GET route.
 *
 *   marketing.campaigns   campaign_send (writes the text, then sends: ONE card), campaign_send_draft (a draft made on the screen), campaign_cancel.
 *                         routes/campaign.routes.ts, `authorize(store_admin, super_admin)` + `requireFeature('email_campaigns')`; same
 *                         campaign.service (createCampaignDraft / requestCampaignSend / cancelCampaign, extracted from the route). A send mails real
 *                         subscribers: confirm, `messagesCustomers`, irreversible; the card carries the audience size and the exact text.
 *   marketing.newsletter  newsletter_broadcast (routes/newsletter.routes.ts POST /broadcast; newsletter-broadcast.service, extracted).
 *   marketing.push-web    push_broadcast (routes/onesignal.routes.ts POST /broadcast, `requireFeature('push_notifications')`; OneSignalService).
 *   notify.whatsapp-link  whatsapp_consent_revoke (routes/whatsapp-link.routes.ts POST /consent/revoke; WhatsAppConsentService). NOT built: connect /
 *                         disconnect (route-inline event fan-out behind `requireMfaEnrolled`, which runAsMerchant cannot honour).
 *   marketing.pixels      pixels_set (routes/store.routes.ts PUT /:id/marketing-pixels; StoreService.updateMarketingPixels). Public pixel ids only: an
 *                         access token is never accepted (the merchant pastes it on the Marketing pixels screen) and never read.
 *   marketing.affiliates  affiliate_review, affiliate_payout (the amount is the pending balance read in state(), never typed).
 *   marketing.loyalty     loyalty_award_points (money-like, bulk by customer count), loyalty_settings_set.
 *   marketing.wallet      wallet_adjust (store credit is money).
 */
import { z } from 'zod/v3';
import type { ToolSpec, TurnCtx } from '@ebda/shared/smart-layer';
import { sha256Hex } from '@ebda/shared/smart-layer';
import { featureService } from '../../services/feature.service';
import { readInStoreContext } from '../../lib/store-scoped-read';
import { storeDb } from '../../lib/repo-factory';
import { CAMPAIGN_MAX_SCHEDULE_DAYS } from '@ebda/shared';
import { maskEmail, maskPhone } from '../../lib/pii-mask';
import {
  CAMPAIGN_LIST_SELECT,
  CampaignQueueUnreachable,
  audienceCount,
  cancelCampaign,
  createCampaignDraft,
  findCampaignOr404,
  requestCampaignSend,
  sentInLast24h,
  storeCampaignDailyCap,
} from '../../services/campaign.service';
import {
  BROADCAST_MAX_RECIPIENTS,
  broadcastNewsletter,
  newsletterAudienceSize,
} from '../../services/newsletter-broadcast.service';
import {
  OneSignalNotConfiguredError,
  OneSignalRequestError,
  OneSignalService,
} from '../../services/onesignal.service';
import { WhatsAppConsentService } from '../../lib/wa/consent';
import { whatsAppLinkState } from '../../lib/wa/link';
import { StoreService } from '../../services/store.service';
import { affiliateService } from '../../services/affiliate.service';
import { LoyaltyService, storeCustomerIdentities } from '../../services/loyalty.service';
import { WalletService, WALLET_MAX_ENTRY_FILS } from '../../services/wallet.service';
import { listLifecycleLog } from '../../services/lifecycle-emails.service';
import { change, egp, f, pair, row, shape, type Described } from './kit';

const OWNER = { roles: ['store_admin'] } as const;
const piasters = (x: number): number => Math.round(x * 100);
const escapeText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Plain text -> the simple paragraphs a campaign / broadcast body stores (the service sanitizes again). */
const textToHtml = (text: string): string =>
  text
    .trim()
    .split(/\n{2,}/)
    .map(p => `<p>${escapeText(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
const parseFuture = (s: string | null | undefined): string | null => {
  if (s === undefined || s === null) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime()))
    throw new Error(`Invalid date: ${s} (use ISO 8601, e.g. 2026-12-01T18:00:00Z)`);
  return d.toISOString();
};
/** The send route's own window (campaign.service requestCampaignSend), checked at PREVIEW so a bad time never leaves a draft behind. */
const parseSchedule = (s: string | null | undefined): string | null => {
  const iso = parseFuture(s);
  if (iso === null) return null;
  const ahead = new Date(iso).getTime() - Date.now();
  if (ahead <= 0 || ahead > CAMPAIGN_MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000)
    throw new Error(
      `Schedule must be in the future and within ${CAMPAIGN_MAX_SCHEDULE_DAYS} days.`
    );
  return iso;
};
/** Who a money card is for: name + masked e-mail, from the store's own customer directory. An id that matches nobody (a name, a fragment, another store's id) refuses. */
async function customerLabels(storeId: string, ids: string[]): Promise<Map<string, string>> {
  const found = await storeCustomerIdentities(storeId, ids);
  const out = new Map<string, string>();
  for (const id of ids) {
    const c = found.get(id);
    if (!c)
      throw new Error(
        `"${id}" is not a customer of this store. Customers can share a name, so pass the customer id from a customer lookup, or ask the merchant which one they mean.`
      );
    out.set(id, `${`${c.firstName} ${c.lastName}`.trim() || 'customer'} (${maskEmail(c.email)})`);
  }
  return out;
}
const uniq = (xs: string[]): string[] => [...new Set(xs)];

// ---- campaigns ------------------------------------------------------------------------------------------------------------------------------
type Reach = { audience: number; sentLast24h: number; dailyCap: number };
const reachOf = async (storeId: string): Promise<Reach> => {
  const [audience, sentLast24h, dailyCap] = await Promise.all([
    audienceCount(storeId),
    sentInLast24h(storeId),
    storeCampaignDailyCap(storeId),
  ]);
  return { audience, sentLast24h, dailyCap };
};
/** The refusals the route raises, raised at PREVIEW so the merchant never gets a card that cannot apply. */
function assertReachable(r: Reach, scheduledAt: string | null): void {
  if (r.audience === 0)
    throw new Error('No subscribers have opted in yet, so there is nobody to send to.');
  const remaining = Math.max(0, r.dailyCap - r.sentLast24h);
  if (!scheduledAt && r.audience > remaining)
    throw new Error(
      `This would reach ${r.audience} people but only ${remaining} more can be sent in the next 24 hours.`
    );
}
const queueFailed = (): Error =>
  new Error('Could not queue the campaign right now. Nothing was sent. Try again.');

type CampaignSendArgs = {
  name?: string;
  subject?: string;
  bodyText?: string;
  subjectAr?: string;
  bodyTextAr?: string;
  scheduledAt?: string | null;
};
const campaignSend = change<CampaignSendArgs>({
  name: 'campaign_send',
  capabilityId: 'marketing.campaigns',
  description:
    'Email ALL newsletter subscribers who opted in, right now or at a scheduled time ("send an Eid offer to my subscribers", "ابعت عرض لكل المشتركين", "ابعت ايميل لعملائي"). You write the text: subject + bodyText (plain text, blank line = new paragraph) in the language of the message, and optionally subjectAr + bodyTextAr for Arabic subscribers. The tool saves a campaign draft and sends it: one card shows the audience size and the exact text; sending real email cannot be undone. An unsubscribe link is added automatically. scheduledAt is optional ISO 8601 (within 30 days). To send a draft the merchant already wrote on the Campaigns screen use campaign_send_draft.',
  schema: shape<CampaignSendArgs>({
    name: f.str('Internal campaign name (defaults to the subject)', { max: 120 }),
    subject: f.str('Email subject', { max: 200 }),
    bodyText: f.str('Email body, plain text', { max: 5000 }),
    subjectAr: f.str('Arabic subject, if sending Arabic copy too', { max: 200 }),
    bodyTextAr: f.str('Arabic body, plain text', { max: 5000 }),
    scheduledAt: f.nullable(f.str('ISO 8601 send time; omit or null = send now', { max: 40 })),
  }),
  policy: 'confirm',
  undo: 'irreversible', // mail that left cannot be recalled; campaign_cancel only stops one that has not started
  messagesCustomers: true,
  // routes/campaign.routes.ts: authorize(store_admin, super_admin) + requireFeature('email_campaigns')
  gate: { ...OWNER, feature: 'email_campaigns' },
  audit: { action: 'campaign.send_requested', resourceType: 'campaign' },
  state: async ctx => reachOf(ctx.storeId),
  describe: (_ctx, a, st): Described => {
    const en = Boolean(a.subject?.trim() && a.bodyText?.trim());
    const ar = Boolean(a.subjectAr?.trim() && a.bodyTextAr?.trim());
    if (!en && !ar) throw new Error('Give a subject and a body in at least one language.');
    if (Boolean(a.subject?.trim()) !== Boolean(a.bodyText?.trim()))
      throw new Error('subject and bodyText go together.');
    if (Boolean(a.subjectAr?.trim()) !== Boolean(a.bodyTextAr?.trim()))
      throw new Error('subjectAr and bodyTextAr go together.');
    const when = parseSchedule(a.scheduledAt);
    const r = st as Reach;
    assertReachable(r, when);
    return {
      summary: pair(
        `هبعت الإيميل ده فعلاً لـ ${r.audience} مشترك ${when ? 'في ' + when : 'دلوقتي'}. الرسالة اللي بتروح بالنص ده بالظبط، ومينفعش أرجّعها بعد ما تتبعت.`,
        `I will email ${r.audience} subscriber(s) ${when ? 'at ' + when : 'right now'} with exactly this text. Sent email cannot be recalled.`
      ),
      rows: [
        row('عدد المشتركين اللي هيوصلهم', 'Audience size', null, r.audience),
        row('العنوان', 'Subject', null, a.subject ?? null),
        row('نص الرسالة', 'Message text', null, a.bodyText ?? null),
        row('العنوان بالعربي', 'Arabic subject', null, a.subjectAr ?? null),
        row('النص بالعربي', 'Arabic message text', null, a.bodyTextAr ?? null),
        row('موعد الإرسال', 'Send time', null, when ?? 'now'),
        row('رابط إلغاء الاشتراك', 'Unsubscribe link', null, 'added automatically'),
      ],
      affectedCount: r.audience,
      restore: null,
    };
  },
  run: async (ctx, a) => {
    const when = parseFuture(a.scheduledAt);
    const subject = a.subject?.trim() || a.subjectAr!.trim();
    const draft = await createCampaignDraft(ctx.storeId, {
      name: (a.name?.trim() || subject).slice(0, 120),
      subject: a.subject?.trim() ?? '',
      subjectAr: a.subjectAr?.trim() ?? null,
      bodyHtml: a.bodyText?.trim() ? textToHtml(a.bodyText) : '',
      bodyHtmlAr: a.bodyTextAr?.trim() ? textToHtml(a.bodyTextAr) : null,
      localeStrategy: 'subscriber',
      audience: { source: 'newsletter' },
    });
    try {
      return await requestCampaignSend(ctx.storeId, draft.id, when ?? undefined);
    } catch (err) {
      throw err instanceof CampaignQueueUnreachable ? queueFailed() : err;
    }
  },
});

type DraftState = Reach & {
  campaign: {
    id: string;
    status: string;
    subject: string;
    subjectAr: string | null;
    bodyHtml: string;
    bodyHtmlAr: string | null;
    updatedAt: Date;
  };
};
type CampaignIdArgs = { campaignId: string; scheduledAt?: string | null };
const campaignSendDraft = change<CampaignIdArgs>({
  name: 'campaign_send_draft',
  capabilityId: 'marketing.campaigns',
  description:
    'Send a campaign DRAFT the merchant already wrote on the Campaigns screen to every opted-in newsletter subscriber ("ابعت الحملة اللي كتبتها", "send my campaign"). campaignId is the draft id. The card shows the audience size and the exact subject and text as saved; if the draft is edited afterwards the card is replaced. Sending cannot be undone. scheduledAt optional ISO 8601.',
  schema: shape<CampaignIdArgs>(
    {
      campaignId: f.id('The draft campaign id'),
      scheduledAt: f.nullable(f.str('ISO 8601 send time; omit or null = now', { max: 40 })),
    },
    ['campaignId']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  messagesCustomers: true,
  gate: { ...OWNER, feature: 'email_campaigns' },
  audit: {
    action: 'campaign.send_requested',
    resourceType: 'campaign',
    resourceId: a => a.campaignId,
  },
  state: async (ctx, a): Promise<DraftState> => {
    // store-scoped: 404s an id that is not this store's campaign
    const c = await findCampaignOr404(ctx.storeId, a.campaignId);
    return {
      campaign: {
        id: c.id,
        status: c.status,
        subject: c.subject,
        subjectAr: c.subjectAr,
        bodyHtml: c.bodyHtml,
        bodyHtmlAr: c.bodyHtmlAr,
        updatedAt: c.updatedAt,
      },
      ...(await reachOf(ctx.storeId)),
    };
  },
  describe: (_ctx, a, st): Described => {
    const s = st as DraftState;
    if (s.campaign.status !== 'draft') throw new Error('This campaign has already been sent.');
    if (
      !(s.campaign.subject.trim() && s.campaign.bodyHtml.trim()) &&
      !(s.campaign.subjectAr?.trim() && s.campaign.bodyHtmlAr?.trim())
    )
      throw new Error('Add a subject and a body in at least one language first.');
    const when = parseSchedule(a.scheduledAt);
    assertReachable(s, when);
    return {
      summary: pair(
        `هبعت الحملة المحفوظة لـ ${s.audience} مشترك ${when ? 'في ' + when : 'دلوقتي'}، بالنص ده بالظبط. مينفعش أرجّعها بعد الإرسال.`,
        `I will send the saved campaign to ${s.audience} subscriber(s) ${when ? 'at ' + when : 'right now'}, with exactly this text. It cannot be recalled.`
      ),
      rows: [
        row('عدد المشتركين اللي هيوصلهم', 'Audience size', null, s.audience),
        row('العنوان', 'Subject', null, s.campaign.subject),
        row('نص الرسالة', 'Message text', null, s.campaign.bodyHtml),
        row('العنوان بالعربي', 'Arabic subject', null, s.campaign.subjectAr),
        row('النص بالعربي', 'Arabic message text', null, s.campaign.bodyHtmlAr),
        row('موعد الإرسال', 'Send time', null, when ?? 'now'),
      ],
      affectedCount: s.audience,
      restore: null,
    };
  },
  run: async (ctx, a) => {
    try {
      return await requestCampaignSend(
        ctx.storeId,
        a.campaignId,
        parseFuture(a.scheduledAt) ?? undefined
      );
    } catch (err) {
      throw err instanceof CampaignQueueUnreachable ? queueFailed() : err;
    }
  },
});

const campaignCancel = change<{ campaignId: string }>({
  name: 'campaign_cancel',
  capabilityId: 'marketing.campaigns',
  description:
    'Stop a scheduled campaign before it starts, or a sending one before its next batch ("وقف الحملة", "cancel my campaign"). Mail already sent stays sent; a cancelled campaign cannot be restarted.',
  schema: shape<{ campaignId: string }>({ campaignId: f.id('The campaign id') }, ['campaignId']),
  policy: 'confirm',
  undo: 'irreversible',
  gate: { ...OWNER, feature: 'email_campaigns' },
  audit: { action: 'campaign.cancelled', resourceType: 'campaign', resourceId: a => a.campaignId },
  state: async (ctx, a) => {
    const c = await findCampaignOr404(ctx.storeId, a.campaignId);
    return { id: c.id, status: c.status, recipientCount: c.recipientCount, sentCount: c.sentCount };
  },
  describe: (_ctx, _a, st): Described => {
    const s = st as { status: string; recipientCount: number; sentCount: number };
    if (!['scheduled', 'sending'].includes(s.status))
      throw new Error('Only a scheduled or sending campaign can be cancelled.');
    return {
      summary: pair(
        `هوقف الحملة. اللي اتبعت لحد دلوقتي (${s.sentCount}) فاضل زي ما هو، والحملة مش هتتشغل تاني.`,
        `I will stop the campaign. The ${s.sentCount} already sent stay sent, and it cannot be restarted.`
      ),
      rows: [
        row('حالة الحملة', 'Campaign status', s.status, 'cancelled'),
        row('اتبعت لحد دلوقتي', 'Already sent', s.sentCount, s.sentCount),
      ],
      affectedCount: 1,
      restore: null,
    };
  },
  run: (ctx, a) => cancelCampaign(ctx.storeId, a.campaignId),
});

// ---- newsletter -----------------------------------------------------------------------------------------------------------------------------
type BroadcastArgs = { subject: string; message: string; language?: string };
const newsletterBroadcast = change<BroadcastArgs>({
  name: 'newsletter_broadcast',
  capabilityId: 'marketing.newsletter',
  description: `Email a short newsletter message to the active newsletter subscribers of the store right now ("ابعت نشرة", "send a newsletter to my subscribers"), up to ${BROADCAST_MAX_RECIPIENTS} people; larger lists use campaign_send. subject + message (plain text, blank line = new paragraph); language optional ("ar" or "en") to reach only that segment. The card shows the audience size and the exact text; sent email cannot be undone.`,
  schema: shape<BroadcastArgs>(
    {
      subject: f.str('Email subject', { max: 300 }),
      message: f.str('Email body, plain text', { max: 5000 }),
      language: f.enum(['ar', 'en'], 'Only subscribers of this language; omit for everyone'),
    },
    ['subject', 'message']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  messagesCustomers: true,
  // routes/newsletter.routes.ts POST /:storeId/newsletter/broadcast: authorize(store_admin, super_admin) + requireFeature('email_campaigns')
  gate: { ...OWNER, feature: 'email_campaigns' },
  audit: { action: 'newsletter.broadcast', resourceType: 'newsletter' },
  state: async (ctx, a) => ({ audience: await newsletterAudienceSize(ctx.storeId, a.language) }),
  describe: (_ctx, a, st): Described => {
    const n = (st as { audience: number }).audience;
    if (n === 0) throw new Error('No active subscribers to send to.');
    if (n > BROADCAST_MAX_RECIPIENTS)
      throw new Error(
        `A broadcast reaches at most ${BROADCAST_MAX_RECIPIENTS} subscribers; use a campaign.`
      );
    return {
      summary: pair(
        `هبعت الرسالة دي لـ ${n} مشترك دلوقتي بالنص ده بالظبط. مينفعش أرجّعها بعد الإرسال.`,
        `I will email ${n} subscriber(s) right now with exactly this text. It cannot be recalled.`
      ),
      rows: [
        row('عدد المشتركين اللي هيوصلهم', 'Audience size', null, n),
        row('الشريحة', 'Language segment', null, a.language ?? 'everyone'),
        row('العنوان', 'Subject', null, a.subject),
        row('نص الرسالة', 'Message text', null, a.message),
      ],
      affectedCount: n,
      restore: null,
    };
  },
  run: async (ctx, a) => {
    const r = await broadcastNewsletter(ctx.storeId, {
      subject: a.subject,
      html: textToHtml(a.message),
      text: a.message,
      language: a.language,
    });
    if (r.kind === 'store_not_found') throw new Error('Store not found');
    if (r.kind === 'too_large')
      throw new Error('Too many subscribers for a broadcast; use a campaign.');
    return r;
  },
});

// ---- web push -------------------------------------------------------------------------------------------------------------------------------
type PushArgs = { titleEn: string; titleAr: string; bodyEn: string; bodyAr: string; url?: string };
const pushBroadcast = change<PushArgs>({
  name: 'push_broadcast',
  capabilityId: 'marketing.push-web',
  description:
    'Send a web push notification to every shopper who allowed notifications on the storefront ("ابعت اشعار لكل عملائي", "عرض فلاش", "send a push to all customers"). Needs a title and a body in BOTH English and Arabic (titleEn, titleAr, bodyEn, bodyAr); url optional, https only, opened when the shopper taps it. The card shows the exact text; a push cannot be recalled.',
  schema: shape<PushArgs>(
    {
      titleEn: f.str('English title', { max: 200 }),
      titleAr: f.str('Arabic title', { max: 200 }),
      bodyEn: f.str('English body', { max: 2000 }),
      bodyAr: f.str('Arabic body', { max: 2000 }),
      url: f.str('https link opened on tap', { max: 500 }),
    },
    ['titleEn', 'titleAr', 'bodyEn', 'bodyAr']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  messagesCustomers: true,
  // routes/onesignal.routes.ts POST /admin/stores/:storeId/push/broadcast: authorize(store_admin, super_admin) + requireFeature('push_notifications')
  gate: { ...OWNER, feature: 'push_notifications' },
  audit: { action: 'push.broadcast.sent', resourceType: 'store', resourceId: () => undefined },
  state: async () => ({ configured: OneSignalService.isConfigured() }),
  describe: (_ctx, a, st): Described => {
    if (!(st as { configured: boolean }).configured)
      throw new Error('Push notifications are not set up on the server yet.');
    if (a.url && !/^https:\/\//i.test(a.url)) throw new Error('The link must start with https://');
    return {
      summary: pair(
        'هبعت الإشعار ده لكل عميل وافق على الإشعارات في متجرك، بالنص ده بالظبط. مينفعش أرجّعه بعد ما يتبعت.',
        'I will send this push to every shopper who allowed notifications on your store, with exactly this text. It cannot be recalled.'
      ),
      rows: [
        row(
          'هيوصل لمين (العدد مش معروف عندنا)',
          'Audience',
          null,
          'every shopper who allowed notifications; audience size unknown to Ebda Store (only the push provider knows it)'
        ),
        row('العنوان بالإنجليزي', 'Title (English)', null, a.titleEn),
        row('العنوان بالعربي', 'Title (Arabic)', null, a.titleAr),
        row('النص بالإنجليزي', 'Body (English)', null, a.bodyEn),
        row('النص بالعربي', 'Body (Arabic)', null, a.bodyAr),
        row('الرابط', 'Link', null, a.url ?? null),
      ],
      affectedCount: 1, // one broadcast; the subscriber count is only known to the provider
      restore: null,
    };
  },
  run: async (ctx, a) => {
    try {
      return await OneSignalService.broadcastToStore({ storeId: ctx.storeId, ...a });
    } catch (err) {
      if (err instanceof OneSignalNotConfiguredError)
        throw new Error('Push notifications are not set up on the server yet.');
      if (err instanceof OneSignalRequestError)
        throw new Error('The push provider could not complete the request. Try again later.');
      throw err;
    }
  },
});

// ---- WhatsApp consent -----------------------------------------------------------------------------------------------------------------------
const whatsappConsentRevoke = change<{ phone: string }>({
  name: 'whatsapp_consent_revoke',
  capabilityId: 'notify.whatsapp-link',
  description:
    'Withdraw ONE customer\'s WhatsApp marketing consent by phone number ("وقف رسايل الواتساب للعميل ده", "stop WhatsApp offers for this number"). Revoke only: a merchant can never grant a customer\'s consent, so this cannot be undone from here. Order and shipping messages are not affected. The card shows the number masked.',
  schema: shape<{ phone: string }>(
    { phone: f.str('The customer phone number', { max: 32, min: 5 }) },
    ['phone']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  // routes/whatsapp-link.routes.ts POST /consent/revoke: authorize(store_admin, super_admin); no plan feature
  gate: OWNER,
  audit: { action: 'whatsapp.consent_revoked', resourceType: 'store', resourceId: () => undefined },
  state: async () => null,
  describe: (_ctx, a): Described => ({
    summary: pair(
      `هسحب موافقة الواتساب التسويقي للرقم ${maskPhone(a.phone)}، ومش هقدر أرجّعها من هنا (العميل بس هو اللي يوافق تاني).`,
      `I will withdraw the WhatsApp marketing consent of ${maskPhone(a.phone)}. Only the customer can grant it again.`
    ),
    rows: [row('رقم العميل', 'Customer number', null, maskPhone(a.phone))],
    affectedCount: 1,
    restore: null,
  }),
  run: async (ctx, a) => {
    const r = await WhatsAppConsentService.record(ctx.storeId, a.phone, {
      consent: false,
      source: 'admin',
    });
    if (!r) throw new Error('That is not a valid phone number.');
    return r;
  },
});

// ---- marketing pixels -----------------------------------------------------------------------------------------------------------------------
/** platform -> the field holding its PUBLIC id (StoreService.updateMarketingPixels copies the same fields). */
const PIXEL_ID_FIELD = {
  meta: 'pixelId',
  tiktok: 'pixelId',
  snapchat: 'pixelId',
  googleAnalytics: 'measurementId',
  googleTagManager: 'containerId',
  googleAds: 'conversionId',
  twitter: 'pixelId',
  pinterest: 'tagId',
} as const;
type PixelPlatform = keyof typeof PIXEL_ID_FIELD;
type PixelArgs = { platform: PixelPlatform; enabled?: boolean; id?: string | null };
type PixelView = { enabled: boolean; id: string | null };
type PixelMap = Record<string, Record<string, unknown> | undefined>;
const pixelView = (all: unknown, p: PixelPlatform): PixelView => {
  const cfg = (all as PixelMap | null | undefined)?.[p];
  const id = cfg?.[PIXEL_ID_FIELD[p]];
  return { enabled: cfg?.enabled === true, id: typeof id === 'string' ? id : null };
};
const readPixels = async (storeId: string): Promise<unknown> =>
  ((await StoreService.getById(storeId)) as { marketingPixels?: unknown }).marketingPixels;
const pixelsSet = change<PixelArgs>({
  name: 'pixels_set',
  capabilityId: 'marketing.pixels',
  description:
    'Turn an ad / analytics pixel on or off and set its PUBLIC id ("حط بكسل فيسبوك", "add my Meta pixel", "TikTok pixel", "Google Analytics G-XXXX"). platform: meta, tiktok, snapchat, googleAnalytics, googleTagManager, googleAds, twitter or pinterest. id = the pixel / measurement / container / conversion / tag id (letters, digits, - and _ only). NEVER paste or send an access token or API secret: the merchant adds Conversions API tokens himself on the Marketing pixels screen.',
  schema: shape<PixelArgs>(
    {
      platform: f.enum(Object.keys(PIXEL_ID_FIELD) as [string, ...string[]], 'Which platform'),
      enabled: f.bool('Turn it on or off'),
      id: f.nullable(f.str('The public pixel id; null removes it', { max: 40 })),
    },
    ['platform']
  ),
  undo: 'reversible',
  // routes/store.routes.ts PUT /:id/marketing-pixels: authorize(store_admin, super_admin) + requireFeature('marketing_pixels')
  gate: { ...OWNER, feature: 'marketing_pixels' },
  audit: { action: 'marketing_pixels.updated', resourceType: 'store', resourceId: () => undefined },
  state: async (ctx, a) => pixelView(await readPixels(ctx.storeId), a.platform),
  describe: (_ctx, a, st): Described => {
    if (a.enabled === undefined && a.id === undefined)
      throw new Error('Say what to change: enabled and/or id.');
    if (typeof a.id === 'string' && (!/^[A-Za-z0-9_-]{3,40}$/.test(a.id) || /^EAA/.test(a.id)))
      throw new Error(
        'That does not look like a public pixel id (letters, digits, - and _ only). Access tokens are never accepted here.'
      );
    const before = st as PixelView;
    const after: PixelView = {
      enabled: a.enabled ?? before.enabled,
      id: a.id === undefined ? before.id : a.id,
    };
    return {
      summary: pair(
        `هغيّر بكسل ${a.platform}: ${after.enabled ? 'شغّال' : 'مقفول'}${after.id ? ' بالرقم ' + after.id : ''}. التوكن (لو موجود) مش هتتغير.`,
        `I will set the ${a.platform} pixel to ${after.enabled ? 'on' : 'off'}${after.id ? ' with id ' + after.id : ''}. Any stored access token is left untouched.`
      ),
      rows: [
        row('شغّال', 'Enabled', before.enabled, after.enabled),
        row('رقم البكسل', 'Pixel id', before.id, after.id),
      ],
      affectedCount: 1,
      restore: before,
    };
  },
  run: async (ctx, a) => {
    const current = ((await readPixels(ctx.storeId)) ?? {}) as PixelMap;
    const key = PIXEL_ID_FIELD[a.platform];
    const next: Record<string, unknown> = { ...(current[a.platform] ?? {}) };
    if (a.enabled !== undefined) next.enabled = a.enabled;
    if (a.id === null) delete next[key];
    else if (a.id !== undefined) next[key] = a.id;
    return StoreService.updateMarketingPixels(ctx.storeId, {
      ...current,
      [a.platform]: next,
    } as never);
  },
  inverse: (a, restore) => {
    const before = restore as PixelView;
    return {
      tool: 'pixels_set',
      args: { platform: a.platform, enabled: before.enabled, id: before.id },
    };
  },
});

// ---- affiliates -----------------------------------------------------------------------------------------------------------------------------
type AffiliateRow = {
  id: string;
  name: string;
  status: string;
  pendingBalance: number;
  commissionRate: number | null;
  updatedAt: Date;
};
const readAffiliate = async (ctx: TurnCtx, id: string): Promise<AffiliateRow> => {
  // store-scoped: 404s an id that is not this store's affiliate
  const a = (await affiliateService.getById(ctx.storeId, id)) as unknown as AffiliateRow;
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    pendingBalance: a.pendingBalance,
    commissionRate: a.commissionRate ?? null,
    updatedAt: a.updatedAt,
  };
};
type ReviewArgs = { affiliateId: string; decision: 'approve' | 'reject' | 'suspend' };
const affiliateReview = change<ReviewArgs>({
  name: 'affiliate_review',
  capabilityId: 'marketing.affiliates',
  description:
    'Approve, reject or suspend an affiliate partner ("وافق على المسوق ده", "approve this affiliate", "suspend the partner"). approve / reject only work on a pending applicant; suspend works on any. A reject or suspend cannot be reversed from here.',
  schema: shape<ReviewArgs>(
    {
      affiliateId: f.id('The affiliate id'),
      decision: f.enum(['approve', 'reject', 'suspend']),
    },
    ['affiliateId', 'decision']
  ),
  policy: 'confirm',
  undo: 'irreversible', // the status machine only allows approve/reject from `pending`; there is no reopen
  // routes/affiliate.routes.ts PATCH /:id/approve|reject|suspend: authorize(store_admin, super_admin) + requireFeature('affiliate')
  gate: { ...OWNER, feature: 'affiliate' },
  audit: {
    action: 'affiliate.reviewed',
    resourceType: 'affiliate',
    resourceId: a => a.affiliateId,
  },
  state: (ctx, a) => readAffiliate(ctx, a.affiliateId),
  describe: (_ctx, a, st): Described => {
    const s = st as AffiliateRow;
    if (a.decision !== 'suspend' && s.status !== 'pending')
      throw new Error(`Only a pending affiliate can be ${a.decision}d; this one is ${s.status}.`);
    const to = { approve: 'approved', reject: 'rejected', suspend: 'suspended' }[a.decision];
    return {
      summary: pair(
        `هغيّر حالة المسوق "${s.name}" من ${s.status} إلى ${to}.`,
        `I will change the affiliate "${s.name}" from ${s.status} to ${to}.`
      ),
      rows: [row('المسوق', 'Affiliate', s.name, s.name), row('الحالة', 'Status', s.status, to)],
      affectedCount: 1,
      restore: null,
    };
  },
  run: (ctx, a) => affiliateService[a.decision](ctx.storeId, a.affiliateId, ctx.userId),
});

type PayoutArgs = { affiliateId: string; method?: string; notes?: string };
const affiliatePayout = change<PayoutArgs>({
  name: 'affiliate_payout',
  capabilityId: 'marketing.affiliates',
  description:
    'Record the payout of an affiliate\'s WHOLE pending commission balance ("ادفع عمولة لمسوق", "pay an affiliate"). The amount is the pending balance on the affiliate (shown on the card); you cannot type an amount. method optional (e.g. "instapay", "cash", default "manual"); notes optional. This books the money as paid out and cannot be undone.',
  schema: shape<PayoutArgs>(
    {
      affiliateId: f.id('The affiliate id'),
      method: f.str('How it was paid', { max: 50 }),
      notes: f.str('Note for the record', { max: 1000 }),
    },
    ['affiliateId']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  // routes/affiliate.routes.ts POST /:id/payouts: authorize(store_admin, super_admin) + requireFeature('affiliate') + rejectImpersonated
  gate: { ...OWNER, feature: 'affiliate' },
  audit: {
    action: 'affiliate.payout_created',
    resourceType: 'affiliate',
    resourceId: a => a.affiliateId,
  },
  state: (ctx, a) => readAffiliate(ctx, a.affiliateId),
  describe: (_ctx, a, st): Described => {
    const s = st as AffiliateRow;
    if (s.pendingBalance <= 0) throw new Error(`${s.name} has no pending balance to pay out.`);
    return {
      summary: pair(
        `هسجّل دفع ${egp(s.pendingBalance)} جنيه للمسوق "${s.name}" (كل رصيده المعلّق). مينفعش أرجّع العملية دي.`,
        `I will record a payout of EGP ${egp(s.pendingBalance)} to "${s.name}" (their whole pending balance). It cannot be undone.`
      ),
      rows: [
        row('المسوق', 'Affiliate', s.name, s.name),
        row('المبلغ (جنيه)', 'Amount (EGP)', null, egp(s.pendingBalance)),
        row(
          'الرصيد المعلّق بعد الدفع (جنيه)',
          'Pending balance after (EGP)',
          egp(s.pendingBalance),
          '0'
        ),
        row('طريقة الدفع', 'Method', null, a.method ?? 'manual'),
        row('ملاحظة', 'Note', null, a.notes ?? null),
      ],
      affectedCount: 1,
      restore: null,
    };
  },
  run: async (ctx, a, st) => {
    const s = st as AffiliateRow;
    // the same balance + affiliate always maps to the same key, so a replay of this exact payout never pays twice
    const key = `assistant-payout-${(await sha256Hex(`${ctx.storeId}:${a.affiliateId}:${s.pendingBalance}`)).slice(0, 32)}`;
    return affiliateService.createPayout(
      ctx.storeId,
      a.affiliateId,
      { amount: s.pendingBalance, method: a.method, notes: a.notes },
      key
    );
  },
});

// ---- loyalty --------------------------------------------------------------------------------------------------------------------------------
type AwardArgs = { customerIds: string[]; points: number; description?: string };
type PointsState = Array<{
  customerId: string;
  label: string;
  points: number;
  /** This very request (same merchant, conversation, day, customers, points, reason) already credited the customer. */
  already: boolean;
}>;
/** Stable across a retry of the same request, different for another request: a half-done award that is re-previewed cannot credit anybody twice. */
async function awardRef(ctx: TurnCtx, a: AwardArgs): Promise<string> {
  const day = new Date(ctx.now).toISOString().slice(0, 10);
  const ids = uniq(a.customerIds).sort().join(',');
  return (
    await sha256Hex(
      `${ctx.storeId}:${ctx.userId}:${ctx.conversationId}:${day}:${ids}:${a.points}:${a.description ?? ''}`
    )
  ).slice(0, 12);
}
const refMark = (ref: string): string => `[ref ${ref}]`;
const loyaltyAward = change<AwardArgs>({
  name: 'loyalty_award_points',
  capabilityId: 'marketing.loyalty',
  description:
    'Give loyalty points (positive) or take points back (negative) for specific customers ("اديله نقاط", "give Mona 200 points", "award points to these customers"). customerIds up to 50, the same points to each; points is a whole number, never 0. Points have value at checkout, so it needs approval; more than 20 customers is flagged as a bulk change. Cannot be undone from here.',
  schema: shape<AwardArgs>(
    {
      customerIds: f.list(f.id('A customer id'), {
        min: 1,
        max: 50,
        description: 'Customers to award',
      }),
      points: f.int('Points each (negative takes points back)', { min: -100_000, max: 100_000 }),
      description: f.str('Reason shown in the customer history', { max: 500 }),
    },
    ['customerIds', 'points']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  // routes/loyalty.routes.ts POST /loyalty/members/:customerId/award: authorize('store_admin') ONLY + requireFeature('loyalty') + rejectImpersonated
  gate: { ...OWNER, feature: 'loyalty' },
  audit: { action: 'loyalty.points_awarded', resourceType: 'loyalty', resourceId: () => undefined },
  refs: a => uniq(a.customerIds).map(id => ({ kind: 'customer', id })),
  state: async (ctx, a): Promise<PointsState> => {
    const ids = uniq(a.customerIds);
    const labels = await customerLabels(ctx.storeId, ids);
    const mark = refMark(await awardRef(ctx, a));
    return Promise.all(
      ids.map(async customerId => {
        const [info, hist] = await Promise.all([
          LoyaltyService.getCustomerPoints(ctx.storeId, customerId),
          LoyaltyService.getTransactionHistory(ctx.storeId, customerId, { limit: 50 }),
        ]);
        return {
          customerId,
          label: labels.get(customerId)!,
          points: info?.points ?? 0,
          already: hist.transactions.some(t => t.description?.includes(mark)),
        };
      })
    );
  },
  describe: (_ctx, a, st): Described => {
    if (a.points === 0) throw new Error('points must not be zero.');
    const all = st as PointsState;
    const rows = all.filter(r => !r.already);
    if (rows.length === 0)
      throw new Error(
        'Every customer in this request was already credited; nothing is left to award.'
      );
    const total = a.points * rows.length;
    return {
      summary: pair(
        `هديّ ${a.points} نقطة لكل واحد من ${rows.length} عميل (الإجمالي ${total} نقطة)${all.length > rows.length ? `، وتخطيت ${all.length - rows.length} اتحسبلهم قبل كده` : ''}. النقاط ليها قيمة في الدفع، ومينفعش أرجّعها من هنا.`,
        `I will give ${a.points} points to each of ${rows.length} customer(s) (${total} in total)${all.length > rows.length ? `, skipping ${all.length - rows.length} already credited by this request` : ''}. Points have checkout value and this cannot be undone from here.`
      ),
      rows: [
        row('عدد العملاء', 'Customers', null, rows.length),
        row('النقاط لكل عميل', 'Points each', null, a.points),
        row('إجمالي النقاط', 'Total points', null, total),
        row('السبب', 'Reason', null, a.description ?? null),
        ...all
          .slice(0, 20)
          .map(r =>
            r.already
              ? row(`${r.label}`, `${r.label}`, r.points, 'already credited, skipped')
              : row(`رصيد ${r.label}`, `Balance of ${r.label}`, r.points, r.points + a.points)
          ),
      ],
      affectedCount: rows.length,
      restore: null,
    };
  },
  run: async (ctx, a, st) => {
    const mark = refMark(await awardRef(ctx, a));
    const done: Array<{ customerId: string; newBalance: number }> = [];
    for (const c of (st as PointsState).filter(r => !r.already)) {
      // the marker rides in the ledger description: a retry of this request sees it (state.already) and skips the customer
      const r = await LoyaltyService.awardBonusPoints(
        ctx.storeId,
        c.customerId,
        a.points,
        a.points > 0 ? 'earn_manual' : 'adjust',
        `${a.description ?? 'Assistant award'} ${mark}`
      );
      done.push({ customerId: c.customerId, newBalance: r.newBalance });
    }
    return { awarded: done.length, customers: done };
  },
});

type LoyaltyArgs = {
  loyaltyEnabled?: boolean;
  pointsPerMajorUnit?: number;
  signupBonus?: number;
  referralBonus?: number;
  reviewBonus?: number;
  birthdayBonus?: number;
};
const LOYALTY_KEYS = [
  'pointsPerMajorUnit',
  'signupBonus',
  'referralBonus',
  'reviewBonus',
  'birthdayBonus',
] as const;
const LOYALTY_LABELS: Record<string, [string, string]> = {
  loyaltyEnabled: ['برنامج الولاء شغّال', 'Loyalty program on'],
  pointsPerMajorUnit: ['نقاط لكل جنيه', 'Points per EGP'],
  signupBonus: ['نقاط التسجيل', 'Signup bonus'],
  referralBonus: ['نقاط الدعوة', 'Referral bonus'],
  reviewBonus: ['نقاط التقييم', 'Review bonus'],
  birthdayBonus: ['نقاط عيد الميلاد', 'Birthday bonus'],
};
const loyaltySettings = change<LoyaltyArgs>({
  name: 'loyalty_settings_set',
  capabilityId: 'marketing.loyalty',
  description:
    'Turn the loyalty program on or off and set how many points customers earn ("ازاي اعمل نقاط ولاء؟", "set up loyalty points", "give 100 points at signup"). Any of: loyaltyEnabled, pointsPerMajorUnit (points per 1 EGP, 1-100), signupBonus, referralBonus, reviewBonus, birthdayBonus (points, 0 or more). Only what you pass changes. It cannot be undone from here; change the values again to correct it.',
  schema: shape<LoyaltyArgs>({
    loyaltyEnabled: f.bool('Turn the program on or off'),
    pointsPerMajorUnit: f.num('Points per 1 EGP spent', { min: 1, max: 100 }),
    signupBonus: f.num('Points at signup', { min: 0 }),
    referralBonus: f.num('Points for a referral', { min: 0 }),
    reviewBonus: f.num('Points for a review', { min: 0 }),
    birthdayBonus: f.num('Points on a birthday', { min: 0 }),
  }),
  policy: 'confirm',
  undo: 'irreversible', // the registry class of marketing.loyalty is irreversible (points awards cannot be taken back), and the engine never lets a tool be softer than its capability
  // routes/loyalty.routes.ts PUT /loyalty/settings: authorize(store_admin, super_admin) + requireFeature('loyalty')
  gate: { ...OWNER, feature: 'loyalty' },
  audit: {
    action: 'loyalty.settings_updated',
    resourceType: 'loyalty',
    resourceId: () => undefined,
  },
  state: async ctx => {
    const s = await LoyaltyService.getSettings(ctx.storeId);
    const o: Record<string, unknown> = { loyaltyEnabled: s.loyaltyEnabled };
    for (const k of LOYALTY_KEYS)
      o[k] = (s.settings as unknown as Record<string, unknown>)[k] ?? null;
    return o;
  },
  describe: (_ctx, a, st): Described => {
    const before = st as Record<string, unknown>;
    const keys = (['loyaltyEnabled', ...LOYALTY_KEYS] as const).filter(k => a[k] !== undefined);
    if (!keys.length) throw new Error('Say what to change.');
    const restore: Record<string, unknown> = {};
    for (const k of keys) restore[k] = before[k];
    return {
      summary: pair(
        'هعدّل إعدادات برنامج الولاء زي ما في الجدول. مفيش تراجع من هنا، ولو غلطت تقدر تعدّلها تاني.',
        'I will change the loyalty settings as listed. There is no undo here; change them again to correct a mistake.'
      ),
      rows: keys.map(k =>
        row(LOYALTY_LABELS[k]![0], LOYALTY_LABELS[k]![1], before[k] ?? null, a[k])
      ),
      affectedCount: 1,
      restore,
    };
  },
  run: (ctx, a) => {
    const { loyaltyEnabled, ...settings } = a;
    return LoyaltyService.updateSettings(ctx.storeId, {
      ...(loyaltyEnabled !== undefined ? { loyaltyEnabled } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
    });
  },
});

// ---- wallet ---------------------------------------------------------------------------------------------------------------------------------
type WalletArgs = { customerId: string; amountEgp: number; note: string };
const walletAdjust = change<WalletArgs>({
  name: 'wallet_adjust',
  capabilityId: 'marketing.wallet',
  description:
    'Give a customer store credit (positive EGP) or take credit back (negative EGP) in their wallet ("اديله رصيد في المحفظة", "give a customer store credit", "refund to wallet"). amountEgp is a decimal in EGP, never 0; note is required (why). A debit cannot take the balance below 0. Store credit is money, so it needs approval and cannot be undone from here (a correction is a second adjustment).',
  schema: shape<WalletArgs>(
    {
      customerId: f.id('The customer id'),
      amountEgp: {
        z: z.number().min(-1_000_000).max(1_000_000),
        js: { type: 'number', minimum: -1_000_000, maximum: 1_000_000, description: 'EGP, signed' },
      },
      note: f.str('Why the credit is adjusted', { max: 500 }),
    },
    ['customerId', 'amountEgp', 'note']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  // routes/wallet.routes.ts POST /:storeId/customers/:customerId/wallet/adjustments: authorize(store_admin, super_admin) + requireFeature('customer_wallet')
  gate: { ...OWNER, feature: 'customer_wallet' },
  audit: {
    action: 'customer.wallet.adjusted',
    resourceType: 'customer_wallet',
    resourceId: a => a.customerId,
  },
  refs: a => [{ kind: 'customer', id: a.customerId }],
  state: async (ctx, a) => ({
    customer: (await customerLabels(ctx.storeId, [a.customerId])).get(a.customerId)!,
    balance: await WalletService.getBalance(ctx.storeId, a.customerId),
  }),
  describe: (_ctx, a, st): Described => {
    const amount = piasters(a.amountEgp);
    const { balance, customer } = st as { balance: number; customer: string };
    if (amount === 0) throw new Error('The amount must not be zero.');
    if (Math.abs(amount) > WALLET_MAX_ENTRY_FILS) throw new Error('That amount is too large.');
    if (balance + amount < 0)
      throw new Error(`The balance is EGP ${egp(balance)}; a debit cannot take it below zero.`);
    return {
      summary: pair(
        `هعدّل رصيد محفظة ${customer} ${amount > 0 ? 'بزيادة' : 'بخصم'} ${egp(Math.abs(amount))} جنيه (من ${egp(balance)} إلى ${egp(balance + amount)}). مينفعش أرجّعها من هنا.`,
        `I will ${amount > 0 ? 'credit' : 'debit'} the wallet of ${customer} by EGP ${egp(Math.abs(amount))} (from ${egp(balance)} to ${egp(balance + amount)}). It cannot be undone from here.`
      ),
      rows: [
        row('العميل', 'Customer', null, customer),
        row('التعديل (جنيه)', 'Adjustment (EGP)', null, egp(amount)),
        row('الرصيد (جنيه)', 'Balance (EGP)', egp(balance), egp(balance + amount)),
        row('السبب', 'Note', null, a.note),
      ],
      affectedCount: 1,
      restore: null,
    };
  },
  run: async (ctx, a, st) => {
    const amount = piasters(a.amountEgp);
    const balance = (st as { balance: number }).balance;
    // same customer + amount + note + balance = same key: a replay of this exact adjustment cannot credit twice
    const requestKey = (
      await sha256Hex(`${ctx.storeId}:${a.customerId}:${amount}:${a.note}:${balance}`)
    ).slice(0, 32);
    return WalletService.adminAdjust({
      storeId: ctx.storeId,
      customerId: a.customerId,
      amount,
      note: a.note,
      actorId: ctx.userId,
      requestKey,
    });
  },
});

// ---- reads (free) ---------------------------------------------------------------------------------------------------------------------------
const MAX_ITEMS = 10;
type ReadDef = {
  name: string;
  capabilityId: string;
  description: string;
  roles: readonly string[];
  feature?: Parameters<typeof featureService.isFeatureEnabled>[1];
  args?: { args: ToolSpec['args']; jsonSchema: Record<string, unknown> };
  trust?: ToolSpec['resultTrust'];
  read: (ctx: TurnCtx, args: Record<string, unknown>) => Promise<unknown>;
};
function readTool(d: ReadDef): ToolSpec {
  const sh = d.args ?? shape({});
  return {
    name: d.name,
    capabilityId: d.capabilityId,
    description: d.description,
    args: sh.args,
    jsonSchema: sh.jsonSchema,
    policy: 'free',
    undo: 'none',
    resultTrust: d.trust ?? 'store-data',
    async read(ctx, args) {
      // the same role + plan gate the screen's GET route has, so a read never shows what the screen would refuse
      if (!d.roles.includes(ctx.role))
        throw new Error(`${d.name} is limited to ${d.roles.join(' / ')}.`);
      if (d.feature && !(await featureService.isFeatureEnabled(ctx.storeId, d.feature)))
        throw new Error(
          `${d.name} needs the "${d.feature}" feature, which is not on for this store.`
        );
      return readInStoreContext(ctx.storeId, () =>
        d.read(ctx, (args ?? {}) as Record<string, unknown>)
      );
    },
  } as ToolSpec;
}
const customerArg = shape<{ customerId?: string }>({ customerId: f.id('A customer id') });

const campaignsOverview = readTool({
  name: 'campaigns_overview',
  capabilityId: 'marketing.overview',
  description:
    'Show the latest email campaigns (status, how many were sent) and how many newsletter subscribers a campaign would reach now, with the daily sending limit ("حملاتي", "كام مشترك هيوصله الايميل", "my campaigns").',
  roles: ['store_admin'],
  feature: 'email_campaigns',
  read: async ctx => ({
    reach: await reachOf(ctx.storeId),
    campaigns: (
      await (
        await storeDb(ctx.storeId)
      ).campaign.findMany({
        where: { storeId: ctx.storeId },
        select: CAMPAIGN_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_ITEMS,
      })
    ).map(c => ({ ...c, lastError: c.lastError ? String(c.lastError).slice(0, 160) : null })),
  }),
});
const newsletterSummary = readTool({
  name: 'newsletter_subscribers_summary',
  capabilityId: 'marketing.overview',
  description:
    'Count the newsletter subscribers and show the newest few with masked emails ("مين اشترك في النشرة؟", "how many subscribers do I have"). To get the full list as a file the merchant uses Export on the Newsletter screen.',
  roles: ['store_admin'],
  trust: 'untrusted',
  read: async ctx => {
    const db = await storeDb(ctx.storeId);
    const [total, active, latest] = await Promise.all([
      db.newsletterSubscriber.count({ where: { storeId: ctx.storeId } }),
      db.newsletterSubscriber.count({ where: { storeId: ctx.storeId, isActive: true } }),
      db.newsletterSubscriber.findMany({
        where: { storeId: ctx.storeId },
        orderBy: { subscribedAt: 'desc' },
        take: 5,
        select: { email: true, language: true, isActive: true, subscribedAt: true },
      }),
    ]);
    return {
      total,
      active,
      latest: latest.map(s => ({ ...s, email: maskEmail(s.email) })),
    };
  },
});
const pushRecent = readTool({
  name: 'push_recent_broadcasts',
  capabilityId: 'marketing.overview',
  description:
    'Show the last web push notifications sent to shoppers with delivery and click counts ("اخر اشعارات بعتها", "how did my last push do").',
  roles: ['store_admin'],
  feature: 'push_notifications',
  read: async ctx => {
    if (!OneSignalService.isConfigured()) return { configured: false, broadcasts: [] };
    return {
      configured: true,
      broadcasts: await OneSignalService.listRecentBroadcasts(ctx.storeId, MAX_ITEMS),
    };
  },
});
const whatsappStatus = readTool({
  name: 'whatsapp_link_status',
  capabilityId: 'marketing.overview',
  description:
    'Say whether the store is linked to Ebda Chat (WhatsApp) and whether the plan includes it ("المتجر مربوط بواتساب؟", "is WhatsApp connected"). Connecting or disconnecting is done on the Notifications screen.',
  roles: ['store_admin'],
  read: ctx => whatsAppLinkState(ctx.storeId),
});
const lifecycleOverview = readTool({
  name: 'lifecycle_emails_overview',
  capabilityId: 'marketing.lifecycle-emails',
  description:
    'List the setup and onboarding emails Ebda Store sends the merchant (welcome, tips) and whether each was sent, skipped or is still pending ("ايه الرسايل اللي بتتبعت لي؟", "what automatic emails are sent").',
  roles: ['store_admin'], // the Setup emails page is owner-only (staff get 403 on the route too)
  read: ctx => listLifecycleLog(ctx.storeId),
});
const affiliatesOverview = readTool({
  name: 'affiliates_overview',
  capabilityId: 'marketing.overview',
  description:
    'Show the affiliate program totals and the newest partners with their status and pending commission ("المسوقين بتوعي", "who is waiting for approval", "how much do I owe affiliates").',
  roles: ['store_admin'],
  feature: 'affiliate',
  trust: 'untrusted',
  read: async ctx => {
    const [stats, list] = await Promise.all([
      affiliateService.getStats(ctx.storeId),
      affiliateService.list(ctx.storeId, { limit: MAX_ITEMS }),
    ]);
    return {
      stats,
      affiliates: (list.affiliates as unknown as AffiliateRow[]).map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        pendingBalanceEgp: egp(a.pendingBalance),
      })),
      total: list.meta.total,
    };
  },
});
const loyaltyOverview = readTool({
  name: 'loyalty_overview',
  capabilityId: 'marketing.overview',
  description:
    'Show the loyalty program settings and totals, or one customer\'s points when customerId is given ("النقاط بتنتهي امتى؟", "how many points does she have", "loyalty stats").',
  roles: ['store_admin'],
  feature: 'loyalty',
  args: customerArg,
  read: async (ctx, a) => {
    const customerId = a.customerId as string | undefined;
    if (customerId)
      return { customer: await LoyaltyService.getCustomerPoints(ctx.storeId, customerId) };
    const [settings, stats] = await Promise.all([
      LoyaltyService.getSettings(ctx.storeId),
      LoyaltyService.getStats(ctx.storeId),
    ]);
    return { settings, stats };
  },
});
const walletOverview = readTool({
  name: 'wallet_overview',
  capabilityId: 'marketing.overview',
  description:
    'Show one customer\'s store-credit balance when customerId is given, otherwise the customers holding the biggest balances and the total owed ("العميل رصيده ايه؟", "who has store credit").',
  roles: ['store_admin'],
  feature: 'customer_wallet',
  args: customerArg,
  trust: 'untrusted',
  read: async (ctx, a) => {
    const customerId = a.customerId as string | undefined;
    if (customerId)
      return {
        customerId,
        balanceEgp: egp(await WalletService.getBalance(ctx.storeId, customerId)),
      };
    const r = await WalletService.listWallets(ctx.storeId, { limit: MAX_ITEMS });
    return {
      summary: r.summary,
      wallets: (r.wallets as Array<{ customerId: string; balance: number }>).map(w => ({
        customerId: w.customerId,
        balanceEgp: egp(w.balance),
      })),
    };
  },
});

export function messagingTools(): ToolSpec[] {
  return [
    campaignSend,
    campaignSendDraft,
    campaignCancel,
    newsletterBroadcast,
    pushBroadcast,
    whatsappConsentRevoke,
    pixelsSet,
    affiliateReview,
    affiliatePayout,
    loyaltyAward,
    loyaltySettings,
    walletAdjust,
    campaignsOverview,
    newsletterSummary,
    pushRecent,
    whatsappStatus,
    lifecycleOverview,
    affiliatesOverview,
    loyaltyOverview,
    walletOverview,
  ];
}
