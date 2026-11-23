/**
 * Self-serve purchases from the assistant (SELF-SERVICE gaps 6 + 7, Ruling AI-ADDON-1, money). Two `confirm` tools wrapping the owner-only checkout of
 * routes/addons.routes.ts (`previewAddon` -> `purchaseAddon`, services/billing/addons.service.ts):
 *   - addon_checkout_start (billing.addons; supersedes the planned self.addon-purchase): a feature add-on (floating widget, wallet checkout, loyalty, upsell, push, affiliate).
 *   - ai_pack_checkout_start (billing.ai-topup; supersedes the planned self.ai-quota-topup): an AI request pack (+N requests a day for 30 days).
 * Rules (each has a test that fails when it is broken):
 *   - the only argument is the sku, an enum read from the server catalogue. The price is NEVER an argument: the card and the confirm token both carry the
 *     catalogue price + VAT quoted by `previewAddon`; if the quote moved between the card and the press the card state (and so the etag) changes and the engine re-previews.
 *   - nothing is charged here. The apply starts the hosted card page (the card number is typed on Kashier, never in chat) and returns its link; the grant happens
 *     only when the signed payment webhook settles the ledger row. No press, no checkout row.
 *   - the confirm token is minted inside the apply, after the merchant's yes, and consumed by `purchaseAddon` (single use, bound to store + user + sku + total).
 *   - one Idempotency-Key per (conversation, sku, quoted total, running term): a retried apply replays the first checkout instead of opening a second.
 *   - tenant: the store is `ctx.storeId`; owner only (the route's `authorize('store_admin', 'super_admin')`; the kit refuses a platform super admin).
 */
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { ADDON_CATALOG, type AddonItem } from '../../services/billing/addon-catalog';
import { listAddons, previewAddon, purchaseAddon } from '../../services/billing/addons.service';
import { change, egp, f, pair, row, shape } from './kit';

type Args = { sku: string };
type Quote = {
  sku: string;
  nameAr: string;
  nameEn: string;
  netMinor: number;
  vatMinor: number;
  totalMinor: number;
  renews: boolean;
  endsAt: string | null;
};

const skusOf = (kind: AddonItem['kind']): [string, ...string[]] =>
  Object.values(ADDON_CATALOG)
    .filter(i => i.kind === kind)
    .map(i => i.sku) as [string, ...string[]];

const GATE = { roles: ['store_admin'] } as const;

async function quoteOf(storeId: string, userId: string, sku: string): Promise<Quote> {
  const [p, list] = await Promise.all([
    previewAddon({ storeId, userId, sku }),
    listAddons(storeId),
  ]);
  const mine = list.addons.find(a => a.sku === sku);
  return {
    sku: p.sku,
    nameAr: p.nameAr,
    nameEn: p.nameEn,
    netMinor: p.netMinor,
    vatMinor: p.vatMinor,
    totalMinor: p.totalMinor,
    renews: p.renews,
    endsAt: mine?.active?.endsAt ? new Date(mine.active.endsAt).toISOString() : null,
  };
}

function checkoutTool(d: {
  name: string;
  capabilityId: string;
  kind: AddonItem['kind'];
  description: string;
  summary: (q: Quote, total: string) => { ar: string; en: string };
}): ToolSpec {
  return change<Args>({
    name: d.name,
    capabilityId: d.capabilityId,
    description: d.description,
    schema: shape<Args>(
      {
        sku: f.enum(
          skusOf(d.kind),
          'The catalogue sku; the price is read from the server, never typed.'
        ),
      },
      ['sku']
    ),
    policy: 'confirm',
    money: true,
    undo: 'irreversible', // a payment is refunded only from the ledger by staff
    gate: GATE,
    audit: {
      action: 'billing.assistant_addon_checkout_started',
      resourceType: 'store_addon',
      resourceId: a => a.sku,
    },
    // state = the server quote (price + VAT) and the running term; it never depends on anything the model typed except the sku
    state: (ctx, a) => quoteOf(ctx.storeId, ctx.userId, a.sku),
    describe: (_ctx, _a, state) => {
      const q = state as Quote;
      const total = egp(q.totalMinor) ?? '0';
      return {
        summary: d.summary(q, total),
        rows: [
          row('المنتج', 'Item', null, pair(q.nameAr, q.nameEn)),
          row('السعر قبل الضريبة بالجنيه', 'Price before VAT in EGP', null, egp(q.netMinor)),
          row('الضريبة بالجنيه', 'VAT in EGP', null, egp(q.vatMinor)),
          row('الإجمالي بالجنيه', 'Total in EGP', null, total),
          row(
            'بيتجدد؟',
            'Renews?',
            null,
            q.renews ? pair('أيوه كل 30 يوم', 'yes, every 30 days') : pair('لا', 'no')
          ),
        ],
        affectedCount: 1,
        changesPrice: false,
        touchesCheckout: true,
      };
    },
    run: async (ctx, a, state) => {
      const q = state as Quote;
      const fresh = await previewAddon({ storeId: ctx.storeId, userId: ctx.userId, sku: a.sku });
      // the engine compares the card's etag (it hashes the server quote) before this runs, so a moved price re-previews; the apply then charges
      // only the total the server quotes now, carried inside the single-use token that `purchaseAddon` verifies against that same quote
      const key =
        `assistant:${ctx.conversationId}:${a.sku}:${fresh.totalMinor}:${q.endsAt ?? 'none'}`
          .replace(/[^A-Za-z0-9._:-]/g, '_')
          .slice(0, 128);
      const out = await purchaseAddon({
        storeId: ctx.storeId,
        userId: ctx.userId,
        sku: a.sku,
        confirmToken: fresh.confirmToken,
        idempotencyKey: key,
      });
      // nothing is charged yet: the card is entered on the hosted page and the grant happens when the payment webhook settles
      return { charged: false, paymentUrl: out.redirectUrl, billingEventId: out.billingEventId };
    },
  });
}

const addonCheckout = checkoutTool({
  name: 'addon_checkout_start',
  capabilityId: 'billing.addons',
  kind: 'feature',
  description:
    'Start the card payment for a feature add-on (Floating Widget, Pay with Wallet at Checkout, Loyalty, Upsell, Push, Affiliate) that is outside my plan. The amount is read from the server. It never charges from chat: it returns the secure card page link. Say: "عايز افعل الزر العائم", "اشتري ميزة الولاء", "can I buy this add-on?".',
  summary: (q, total) =>
    pair(
      `شراء «${q.nameAr}»: هنفتحلك صفحة الدفع الآمنة بإجمالي ${total} جنيه شامل الضريبة${q.renews ? ' ويتجدد كل 30 يوم' : ''}. مفيش خصم قبل ما تدخل بيانات الكارت وتأكد هناك. المساعد مش بيدخل بيانات الكارت.`,
      `Buy "${q.nameEn}": opens the secure card page for ${total} EGP including VAT${q.renews ? ', renewing every 30 days' : ''}. Nothing is charged until you enter your card and confirm there. The assistant never handles card details.`
    ),
});

const aiPackCheckout = checkoutTool({
  name: 'ai_pack_checkout_start',
  capabilityId: 'billing.ai-topup',
  kind: 'ai_topup',
  description:
    'Start the card payment for an AI request pack (more AI requests a day for 30 days; it does not renew). The amount is read from the server. It never charges from chat: it returns the secure card page link. Say: "الذكاء وقف النهارده", "عايز اشتري كريدت ذكاء", "I hit my AI limit, can I top up?".',
  summary: (q, total) =>
    pair(
      `شراء «${q.nameAr}» لمدة 30 يوم: هنفتحلك صفحة الدفع الآمنة بإجمالي ${total} جنيه شامل الضريبة ومش بيتجدد. مفيش خصم قبل ما تدخل بيانات الكارت وتأكد هناك. الباقة بتزود حد متجرك بس.`,
      `Buy "${q.nameEn}" for 30 days: opens the secure card page for ${total} EGP including VAT, no renewal. Nothing is charged until you enter your card and confirm there. A pack raises only your own store's daily limit.`
    ),
});

export function addonCheckoutTools(): ToolSpec[] {
  return [addonCheckout, aiPackCheckout];
}
