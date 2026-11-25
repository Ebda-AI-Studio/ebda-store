/**
 * Phase E1 (plan 4): account, billing, team and integrations. Declared with `change()` / read specs from ./kit and ./read.tools.
 *
 * Reads (`free`; owner screens, same role check as `quote_plan`):
 *   - billing_overview (billing.view): GET /stores/:storeId/billing (plan, status, limits, usage, InstaPay state). `getUsageSummary` + `getSubscriptionBillingState`.
 *   - billing_invoices (billing.platform-fee-vat): GET .../billing/invoices (`listStoreCharges`, VAT split included).
 *   - my_features (billing.addons): GET /stores/:storeId/my-features (`authenticate` + store membership only, no role list, so none here either).
 *   - list_my_stores (account.multi-store): GET /stores (`StoreService.list` as the owner).
 *   - merchant_mcp_status (mcp.read-tools): GET .../integrations/merchant-keys + write-switch, METADATA ONLY (no key hash, no plaintext: it is never stored).
 * Ruling E1-PLAN-1 - `plan_change` never charges the saved card from chat. A downgrade (or a change that charges nothing) is a confirm card that calls
 *   `changePlan`; an UPGRADE (new price above the current one) previews the exact amounts (net, VAT, total from `chargeFor`'s math under the current platform VAT) and
 *   its apply only returns the billing screen link where the merchant confirms the charge. Card payments are deep links only, like the Chat assistant. The VAT state is
 *   part of the card's state fingerprint, so turning VAT on between the card and the press refreshes the card. Cost if wrong: an upgrade needs one extra tap on the
 *   billing screen; the opposite mistake would charge a card on a model's say-so with a figure that can omit VAT.
 * Changes (routes/billing.routes.ts, routes/onboarding.routes.ts, routes/staff.routes.ts, routes/merchant-key.routes.ts; all `authorize('store_admin', ...)`):
 *   - plan_change / subscription_cancel / subscription_resume (billing.change-plan): money. The price shown is the plan catalogue's (`planService`), never a model number.
 *   - instapay_plan_choose (billing.pay-instapay): `chooseInstapayPlan` picks the plan the next InstaPay payment buys and returns the reference + the billing screen
 *     where the receipt is uploaded (the upload stays on the screen: a file).
 *   - store_go_live (onboarding.payment-methods-and-go-live): `OnboardingService.goLive` (needs a verified e-mail, like the route).
 *   - merchant_mcp_write_switch (integrations.merchant-mcp): the non-secret `mcpWriteEnabled` switch. Minting a key shows a secret once: screen only.
 *   - staff_remove (team.staff): `removeStaffFromStore` (extracted from the route, behaviour unchanged).
 */
import type { ToolSpec, TurnCtx } from '@ebda/shared/smart-layer';
import { withUser } from '@ebda/database';
import { hasPermission, type Role } from '../../middleware/rbac';
import { assertVerifiedEmail } from '../../middleware/require-verified-email';
import { featureService } from '../../services/feature.service';
import { getUsageSummary } from '../../services/plan-limit.service';
import { planService } from '../../services/plan.service';
import {
  resolvePlatformVat,
  subscriptionChargeAmount,
  type PlatformVat,
} from '../../services/billing/charge-amount';
import { StoreService } from '../../services/store.service';
import { OnboardingService } from '../../services/onboarding.service';
import { chooseInstapayPlan } from '../../services/billing/account.service';
import {
  cancelSubscription,
  changePlan,
  getSubscriptionBillingState,
  listStoreCharges,
  resumeSubscription,
} from '../../services/billing/subscription-billing.service';
import { listStaffWithUsers, removeStaffFromStore } from '../../services/staff-members.service';
import { storeDb } from '../../lib/repo-factory';
import { readInStoreContext } from '../../lib/store-scoped-read';
import { ReadForbidden } from '../merchant-read';
import { compact } from './read.tools';
import { change, egp, f, pair, row, shape } from './kit';

type Rec = Record<string, unknown>;
const OWNER = ['store_admin'] as const;

// ---- reads --------------------------------------------------------------------------------------------------------------------------------
const none = shape({});
const ownerOnly = (ctx: TurnCtx): void => {
  // the billing / integrations screens are the owner's (`authorize('store_admin', ...)`); `store:settings` is held by exactly that role
  if (!hasPermission(ctx.role as Role, 'store:settings')) throw new ReadForbidden('store:settings');
};
const readTool = (
  name: string,
  capabilityId: string,
  description: string,
  read: (ctx: TurnCtx) => Promise<unknown>,
  resultTrust: ToolSpec['resultTrust'] = 'typed-source'
): ToolSpec =>
  ({
    name,
    capabilityId,
    description,
    args: none.args,
    jsonSchema: none.jsonSchema,
    policy: 'free',
    undo: 'none',
    resultTrust,
    read: (ctx: TurnCtx) => read(ctx),
  }) as unknown as ToolSpec;

const billingOverview = readTool(
  'billing_overview',
  'billing.view',
  'My subscription and plan: current plan, trial or renewal date, whether it renews or is cancelled, what I use against the limits (products, staff, orders), InstaPay payment status. Say: "what plan am I on", "when does my subscription renew", "باقتي ايه", "الاشتراك بيجدد امتى".',
  async ctx => {
    ownerOnly(ctx);
    return readInStoreContext(ctx.storeId, async () => {
      const [{ entitlements: e, usage }, billing] = await Promise.all([
        getUsageSummary(ctx.storeId),
        getSubscriptionBillingState(ctx.storeId),
      ]);
      return compact({
        plan: { code: e.planCode, name: { ar: e.planNameAr, en: e.planNameEn } },
        subscription: {
          status: e.status,
          currentPeriodEnd: e.currentPeriodEnd,
          trialEndsAt: e.trialEndsAt,
          cancelAtPeriodEnd: e.cancelAtPeriodEnd,
        },
        limits: e.limits,
        usage,
        billing: {
          interval: billing.billingInterval,
          pendingInterval: billing.pendingBillingInterval,
          pendingPlanCode: billing.pendingPlanCode,
          method: billing.billingMethod,
          hasPaymentMethod: billing.hasPaymentMethod,
          overdue: billing.overdue,
          instapay: {
            available: billing.instapay.available,
            reference: billing.instapay.reference,
            amountEgp: egp(billing.instapay.amountMinor),
            pendingClaims: billing.instapay.pendingClaims,
          },
        },
      });
    });
  }
);

const billingInvoices = readTool(
  'billing_invoices',
  'billing.platform-fee-vat',
  'My Ebda Store subscription charges and invoices (date, plan, amount, VAT, status). Say: "show my invoices", "what did Ebda Store charge me", "فواتير الاشتراك", "الضريبة على الفاتورة".',
  async ctx => {
    ownerOnly(ctx);
    return compact(await readInStoreContext(ctx.storeId, () => listStoreCharges(ctx.storeId, 10)));
  }
);

const myFeatures = readTool(
  'my_features',
  'billing.addons',
  'Which features are on or off for my store and why a feature is locked (plan or switched off by Ebda Store). It cannot turn a feature on: that is the Ebda Store team or a plan upgrade. Say: "why is this feature locked", "what features do I have", "الميزة دي مقفولة ليه", "عايز افعل الزر العائم".',
  async ctx => {
    const features = await readInStoreContext(ctx.storeId, () =>
      featureService.getStoreFeatures(ctx.storeId)
    );
    const keys = Object.keys(features).sort();
    return {
      enabled: keys.filter(k => (features as Record<string, boolean>)[k]),
      disabled: keys.filter(k => !(features as Record<string, boolean>)[k]),
      note: 'A disabled feature is turned on by upgrading the plan or by the Ebda Store team; the assistant cannot enable it.',
    };
  }
);

const listMyStores = readTool(
  'list_my_stores',
  'account.multi-store',
  'The stores I own (name, address, status, product and order counts). Say: "how many stores do I have", "can I open another store", "متاجري", "اتنقل لمتجر تاني".',
  async ctx => {
    ownerOnly(ctx);
    const r = await withUser(ctx.userId, () =>
      StoreService.list({ ownerId: ctx.userId, page: 1, limit: 10 })
    );
    return compact({
      total: r.meta.total,
      stores: r.stores.map((s: Rec) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        status: s.status,
        counts: s._count,
      })),
    });
  }
);

const merchantMcpStatus = readTool(
  'merchant_mcp_status',
  'mcp.read-tools',
  'My Merchant MCP connection (Claude or another AI app reading my store): and whether AI write tools are switched on. It never shows a key and does not list them: the keys are on the Merchant MCP screen. Say: "who can read my store from Claude", "MCP keys", "مفاتيح MCP".',
  async ctx => {
    ownerOnly(ctx);
    if (!(await featureService.isFeatureEnabled(ctx.storeId, 'merchant_mcp'))) {
      throw new ReadForbidden('merchant_mcp');
    }
    return readInStoreContext(ctx.storeId, async () => {
      const settings =
        ((await StoreService.getById(ctx.storeId)).settings as Rec | null) ?? ({} as Rec);
      // The key list itself (names, scopes, last used) stays on the Merchant MCP screen: its rows live in the platform key store, not in the store's own data.
      return compact({
        writeEnabled: settings.mcpWriteEnabled !== false,
        keysScreen: '/stores/[id]/settings/integrations',
      });
    });
  },
  'store-data'
);

// ---- billing writes -------------------------------------------------------------------------------------------------------------------------
type Plan = Awaited<ReturnType<typeof planService.listPlans>>[number];
type Interval = 'monthly' | 'yearly';
const priceOf = (p: Plan | undefined, interval: Interval): number | null =>
  p ? (interval === 'yearly' ? p.priceYearlyMinor : p.priceMonthlyMinor) : null;

/** The store's subscription as the billing screen shows it (the same readers), plus the catalogue plan the call targets. Depends on ids only. */
async function billingState(storeId: string, planCode?: string) {
  const [{ entitlements: e }, b, plans, vat] = await Promise.all([
    getUsageSummary(storeId),
    getSubscriptionBillingState(storeId),
    planService.listPlans({ publicOnly: true }),
    resolvePlatformVat(),
  ]);
  // the store's CURRENT plan, from the plan record itself (a hidden or legacy plan is not in the public list)
  const cur = await planService.getPlan(e.planCode).catch(() => undefined);
  return {
    planCode: e.planCode,
    planName: { ar: e.planNameAr, en: e.planNameEn },
    status: e.status,
    cancelAtPeriodEnd: e.cancelAtPeriodEnd,
    currentPeriodEnd: e.currentPeriodEnd ? new Date(e.currentPeriodEnd).toISOString() : null,
    interval: (b.billingInterval === 'yearly' ? 'yearly' : 'monthly') as Interval,
    pendingPlanCode: b.pendingPlanCode,
    hasPaymentMethod: b.hasPaymentMethod,
    limits: (e.limits ?? {}) as Rec,
    /** Ebda Store's platform VAT right now: part of the fingerprint, so a change refreshes the card. */
    vat: { enabled: vat.enabled, rateBps: vat.rateBps, mode: vat.mode },
    currentPriceMinor: priceOf(cur, b.billingInterval === 'yearly' ? 'yearly' : 'monthly'),
    target: planCode
      ? ((): unknown => {
          const t = plans.find(p => p.code === planCode);
          return t
            ? {
                code: t.code,
                name: { ar: t.nameAr, en: t.nameEn },
                monthlyMinor: t.priceMonthlyMinor,
                yearlyMinor: t.priceYearlyMinor,
                limits: (t.limits ?? {}) as Rec,
              }
            : null;
        })()
      : null,
  };
}
type BState = Awaited<ReturnType<typeof billingState>>;
type Target = {
  code: string;
  name: { ar: string; en: string };
  monthlyMinor: number | null;
  yearlyMinor: number | null;
  limits: Rec;
};
const targetOf = (st: BState, planCode: string): Target => {
  if (!st.target)
    throw new Error(`There is no plan "${planCode}" to buy. Ask for the plans first.`);
  return st.target as Target;
};
const targetPrice = (t: Target, interval: Interval) =>
  interval === 'yearly' ? t.yearlyMinor : t.monthlyMinor;
/** The amounts a payment of `price` would be, under the VAT captured in the card's state (same math as `chargeFor`). */
const amountOf = (price: number | null, st: BState) =>
  price === null ? null : subscriptionChargeAmount(price, st.vat as PlatformVat);
const isUpgrade = (st: BState, price: number | null) =>
  price !== null && (st.currentPriceMinor ?? 0) < price;
const amountRows = (price: number | null, st: BState) => {
  const c = amountOf(price, st);
  return c
    ? [
        row('السعر قبل الضريبة بالجنيه', 'Price before VAT in EGP', null, egp(c.netMinor)),
        row('الضريبة بالجنيه', 'VAT in EGP', null, egp(c.vatMinor)),
        row('الإجمالي بالجنيه', 'Total in EGP', null, egp(c.totalMinor)),
      ]
    : [];
};

/** The plan limits that differ between the current and the new plan: the "what changes for me" list. */
function limitRows(cur: Rec, next: Rec) {
  return [...new Set([...Object.keys(cur), ...Object.keys(next)])]
    .sort()
    .filter(k => JSON.stringify(cur[k] ?? null) !== JSON.stringify(next[k] ?? null))
    .map(k => row(`حد: ${k}`, `Limit: ${k}`, cur[k] ?? null, next[k] ?? null));
}

const BILLING_GATE = { roles: OWNER } as const; // routes/billing.routes.ts `writeGuard`: authorize('store_admin', 'super_admin')
const MONEY_WORDS = 'Say: ';

const planChange = change<{ planCode: string }>({
  name: 'plan_change',
  capabilityId: 'billing.change-plan',
  description: `Upgrade or downgrade my Ebda Store plan to another plan by its code (get the codes and prices from quote_plan). The price is read from the plan catalogue, never typed. An upgrade charges the card on file immediately; a downgrade starts at the end of the paid period. ${MONEY_WORDS}"upgrade me to Growth", "اترقى لباقة Growth", "انزل الباقة".`,
  schema: shape<{ planCode: string }>(
    { planCode: f.id('The plan code, exactly as quote_plan returns it.') },
    ['planCode']
  ),
  policy: 'confirm',
  money: true,
  undo: 'irreversible', // an upgrade charges at once; a downgrade's effects are not undoable instantly (registry note)
  gate: BILLING_GATE,
  audit: { action: 'billing.assistant_plan_changed', resourceType: 'store_subscription' },
  state: (ctx, a) => billingState(ctx.storeId, a.planCode),
  describe: (_ctx, a, state) => {
    const st = state as BState;
    const t = targetOf(st, a.planCode);
    const price = targetPrice(t, st.interval);
    const upgrade = isUpgrade(st, price);
    const total = amountOf(price, st)?.totalMinor ?? null;
    return {
      summary: pair(
        upgrade
          ? `الترقية من ${st.planName.ar} إلى ${t.name.ar} بتتأكد من شاشة الدفع: افتح شاشة الدفع عشان تأكد خصم ${egp(total)} جنيه شامل الضريبة (${st.interval === 'yearly' ? 'سنوي' : 'شهري'}). المساعد مش بيخصم من الكارت بنفسه.`
          : `تغيير باقتك من ${st.planName.ar} إلى ${t.name.ar}. الباقة الجديدة هتبدأ في آخر الفترة المدفوعة ومفيش خصم دلوقتي. التغيير ده مش بيترجع بضغطة.`,
        upgrade
          ? `Upgrading from ${st.planName.en} to ${t.name.en} is confirmed on the payment screen: open it to confirm the charge of ${egp(total)} EGP including VAT (${st.interval}). The assistant never charges your card itself.`
          : `Change your plan from ${st.planName.en} to ${t.name.en}. The new plan starts at the end of the paid period and nothing is charged now. This cannot be undone with one press.`
      ),
      rows: [
        row('الباقة', 'Plan', st.planCode, t.code),
        row(
          `السعر (${st.interval === 'yearly' ? 'سنوي' : 'شهري'}) بالجنيه`,
          `Price (${st.interval}) in EGP`,
          egp(st.currentPriceMinor),
          egp(price)
        ),
        ...(upgrade ? amountRows(price, st) : []),
        row(
          'متى يبدأ',
          'When it starts',
          null,
          upgrade
            ? pair('بعد تأكيد الدفع من الشاشة', 'after you confirm the payment on the screen')
            : pair('آخر الفترة المدفوعة', 'end of the paid period')
        ),
        ...limitRows(st.limits, t.limits),
      ],
      affectedCount: 1,
    };
  },
  run: (ctx, a, state) => {
    const st = state as BState;
    const t = targetOf(st, a.planCode);
    if (isUpgrade(st, targetPrice(t, st.interval))) {
      // Ruling E1-PLAN-1: an upgrade charges the saved card, so it is never done from chat: the link is the answer
      return Promise.resolve({
        charged: false,
        paymentScreen: `/stores/${ctx.storeId}/billing`,
        planCode: a.planCode,
      });
    }
    return changePlan({ storeId: ctx.storeId, planCode: a.planCode });
  },
});

const subscriptionCancel = change<Record<string, never>>({
  name: 'subscription_cancel',
  capabilityId: 'billing.change-plan',
  description:
    'Cancel my paid Ebda Store subscription at the end of the period I already paid for (immediately if the payment is overdue). Say: "cancel my subscription", "الغي الاشتراك".',
  schema: shape<Record<string, never>>({}),
  policy: 'confirm',
  money: true,
  undo: 'irreversible', // an overdue cancel downgrades at once; resuming is a separate confirmed tool
  gate: BILLING_GATE,
  audit: { action: 'billing.assistant_cancelled', resourceType: 'store_subscription' },
  state: ctx => billingState(ctx.storeId),
  describe: (_ctx, _a, state) => {
    const st = state as BState;
    const overdue = st.status === 'past_due' || !st.currentPeriodEnd;
    return {
      summary: pair(
        overdue
          ? `إلغاء اشتراكك في ${st.planName.ar}: هيتحول متجرك للباقة المجانية فورًا.`
          : `إلغاء اشتراكك في ${st.planName.ar}: هيفضل شغال لحد ${st.currentPeriodEnd} وبعدها يتحول للباقة المجانية.`,
        overdue
          ? `Cancel ${st.planName.en}: the store drops to the free plan right away.`
          : `Cancel ${st.planName.en}: it stays active until ${st.currentPeriodEnd}, then drops to the free plan.`
      ),
      rows: [
        row('الباقة', 'Plan', st.planCode, 'free'),
        row(
          'الإلغاء',
          'Cancellation',
          st.cancelAtPeriodEnd,
          overdue ? pair('فورًا', 'now') : pair('آخر الفترة', 'at period end')
        ),
        row('ينتهي في', 'Ends on', st.currentPeriodEnd, overdue ? null : st.currentPeriodEnd),
      ],
      affectedCount: 1,
    };
  },
  run: ctx => cancelSubscription({ storeId: ctx.storeId }),
});

const subscriptionResume = change<Record<string, never>>({
  name: 'subscription_resume',
  capabilityId: 'billing.change-plan',
  description:
    'Undo a scheduled cancellation: keep my paid Ebda Store plan so it renews as usual. Only works before the period ends. Say: "resume my subscription", "كمل الاشتراك", "مش عايز الغي".',
  schema: shape<Record<string, never>>({}),
  policy: 'confirm',
  money: true,
  undo: 'irreversible',
  gate: BILLING_GATE,
  audit: { action: 'billing.assistant_resumed', resourceType: 'store_subscription' },
  state: ctx => billingState(ctx.storeId),
  describe: (_ctx, _a, state) => {
    const st = state as BState;
    return {
      summary: pair(
        `استكمال اشتراكك في ${st.planName.ar}: هيتجدد في معاده العادي.`,
        `Keep ${st.planName.en}: it renews on its normal date.`
      ),
      rows: [
        row('هيتلغي في آخر الفترة؟', 'Cancels at period end?', st.cancelAtPeriodEnd, false),
        row('تجديد في', 'Renews on', st.currentPeriodEnd, st.currentPeriodEnd),
      ],
      affectedCount: 1,
    };
  },
  run: ctx => resumeSubscription({ storeId: ctx.storeId }),
});

const instapayPlanChoose = change<{ planCode: string; interval: Interval }>({
  name: 'instapay_plan_choose',
  capabilityId: 'billing.pay-instapay',
  description: `Start paying for a plan by InstaPay: picks the plan and billing period the next InstaPay transfer buys and returns the payment reference to write on the transfer and the billing screen where I upload the receipt screenshot (the upload itself stays on that screen). Nothing is charged and the plan does not change until the Ebda Store team approves the payment. ${MONEY_WORDS}"I want to pay by InstaPay", "ادفع انستاباي", "عايز ادفع اشتراك Growth بانستاباي". The price comes from the plan catalogue.`,
  schema: shape<{ planCode: string; interval: Interval }>(
    {
      planCode: f.id('The plan code, as quote_plan returns it.'),
      interval: f.enum(['monthly', 'yearly'], 'monthly or yearly'),
    },
    ['planCode', 'interval']
  ),
  policy: 'confirm',
  money: true,
  undo: 'irreversible', // choosing again overwrites it, but a reference is issued and the payment claim is Ebda Store's to review
  gate: BILLING_GATE,
  audit: { action: 'billing.instapay_plan_chosen', resourceType: 'store_subscription' },
  state: (ctx, a) => billingState(ctx.storeId, a.planCode),
  describe: (_ctx, a, state) => {
    const st = state as BState;
    const t = targetOf(st, a.planCode);
    const price = targetPrice(t, a.interval);
    return {
      summary: pair(
        `الدفع بانستاباي لباقة ${t.name.ar} (${a.interval === 'yearly' ? 'سنوي' : 'شهري'}): المطلوب تحويله ${egp(amountOf(price, st)?.totalMinor ?? null)} جنيه شامل الضريبة. مفيش حاجة هتتخصم دلوقتي، وهتحول وترفع صورة الإيصال من شاشة الاشتراك.`,
        `Pay for ${t.name.en} (${a.interval}) by InstaPay: the transfer is ${egp(amountOf(price, st)?.totalMinor ?? null)} EGP including VAT. Nothing is charged now; you transfer and upload the receipt on the billing screen.`
      ),
      rows: [
        row('الباقة', 'Plan', st.pendingPlanCode ?? st.planCode, t.code),
        row('الدورة', 'Period', st.interval, a.interval),
        ...amountRows(price, st),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => ({
    instapay: await chooseInstapayPlan({
      storeId: ctx.storeId,
      planCode: a.planCode,
      interval: a.interval,
    }),
    uploadReceiptAt: `/stores/${ctx.storeId}/billing`,
  }),
});

// ---- onboarding -----------------------------------------------------------------------------------------------------------------------------
const storeGoLive = change<Record<string, never>>({
  name: 'store_go_live',
  capabilityId: 'onboarding.payment-methods-and-go-live',
  description:
    'Publish my store so shoppers can see it and order (inactive -> active). It needs a verified e-mail, a valid plan or trial and at least one payment method on. Say: "go live", "publish my store", "افتح المتجر للعملاء", "انشر المتجر".',
  schema: shape<Record<string, never>>({}),
  policy: 'confirm',
  undo: 'irreversible', // no merchant-side "unpublish" tool; the registry note: reversible only by a super-admin status change
  gate: { roles: OWNER }, // POST /onboarding/stores/:storeId/go-live: authorize('store_admin', ...) + requireVerifiedEmail
  audit: { action: 'store.went_live', resourceType: 'store' },
  state: async ctx => {
    // the route's second gate (`requireVerifiedEmail`), checked at preview AND apply (state runs at both): refuse early
    await assertVerifiedEmail({ userId: ctx.userId, role: ctx.role });
    const db = await storeDb(ctx.storeId);
    const store = await db.store.findUnique({
      where: { id: ctx.storeId },
      select: { status: true, name: true, slug: true },
    });
    if (!store) throw new Error('Store not found');
    const methods = await db.paymentConfig.count({
      where: { storeId: ctx.storeId, isEnabled: true },
    });
    return { status: store.status, name: store.name, slug: store.slug, paymentMethods: methods };
  },
  describe: (_ctx, _a, state) => {
    const st = state as { status: string; name: string; paymentMethods: number };
    return {
      summary: pair(
        `نشر متجر "${st.name}": بعدها أي عميل يقدر يشوفه ويطلب منه.`,
        `Publish "${st.name}": shoppers can then see it and order.`
      ),
      rows: [
        row('حالة المتجر', 'Store status', st.status, 'active'),
        row('طرق الدفع المفعّلة', 'Payment methods on', st.paymentMethods, st.paymentMethods),
      ],
      affectedCount: 1,
      touchesCheckout: true,
    };
  },
  run: ctx => OnboardingService.goLive(ctx.storeId),
});

// ---- integrations ---------------------------------------------------------------------------------------------------------------------------
const mcpSwitch = change<{ enabled: boolean }>({
  name: 'merchant_mcp_write_switch',
  capabilityId: 'integrations.merchant-mcp',
  description:
    'Turn on or off whether AI apps connected through my Merchant MCP keys may CHANGE my store (reading stays on). It never creates, shows or revokes a key: those stay on the Merchant keys screen. Say: "stop Claude from editing my store", "اقفل الكتابة على MCP", "خلي Claude يقدر يعدل".',
  schema: shape<{ enabled: boolean }>({ enabled: f.bool('true = AI apps may change the store') }, [
    'enabled',
  ]),
  policy: 'confirm',
  undo: 'reversible',
  // PUT .../integrations/merchant-mcp/write-switch: authorize('store_admin', ...) + requireFeature('merchant_mcp')
  gate: { roles: OWNER, feature: 'merchant_mcp' },
  audit: { action: 'store.merchant_mcp_write_switch', resourceType: 'store' },
  state: async ctx => {
    const s = ((await StoreService.getById(ctx.storeId)).settings as Rec | null) ?? ({} as Rec);
    return { enabled: s.mcpWriteEnabled !== false };
  },
  describe: (_ctx, a, state) => {
    const before = (state as { enabled: boolean }).enabled;
    return {
      summary: a.enabled
        ? pair(
            'السماح لتطبيقات الـ AI المربوطة بمفاتيح MCP إنها تعدّل في متجرك',
            'Allow AI apps connected by MCP keys to change your store'
          )
        : pair(
            'منع تطبيقات الـ AI المربوطة بمفاتيح MCP من التعديل في متجرك (القراءة تفضل شغالة)',
            'Stop AI apps connected by MCP keys from changing your store (reading stays on)'
          ),
      rows: [row('الكتابة عن طريق MCP', 'Writes through MCP', before, a.enabled)],
      affectedCount: 1,
      restore: { enabled: before },
    };
  },
  run: (ctx, a) => StoreService.setMcpWriteEnabled(ctx.storeId, a.enabled),
  inverse: (_a, restore) =>
    restore ? { tool: 'merchant_mcp_write_switch', args: restore as Rec } : null,
});

// ---- team -----------------------------------------------------------------------------------------------------------------------------------
const staffRemove = change<{ email: string }>({
  name: 'staff_remove',
  capabilityId: 'team.staff',
  description:
    'Remove a team member from my store by their e-mail: they lose access to this store at once, their pending invitations expire and their Merchant MCP keys are revoked. Inviting a new member stays on the Team screen. Say: "remove this employee", "شيل موظف", "الموظف سابني".',
  schema: shape<{ email: string }>(
    { email: f.str("The staff member's e-mail address.", { max: 254 }) },
    ['email']
  ),
  policy: 'confirm',
  deletes: true,
  // the registry says reversible (remove, then invite again); there is no invite tool, so the tool is declared irreversible (the stricter class)
  undo: 'irreversible',
  // DELETE .../staff/:userId: authorize('store_admin', ...) + requireFeature('staff_accounts')
  gate: { roles: OWNER, feature: 'staff_accounts' },
  audit: { action: 'staff.removed', resourceType: 'store_staff' },
  state: async (ctx, a) => {
    const want = a.email.trim().toLowerCase();
    const m = (await listStaffWithUsers(ctx.storeId)).find(
      x => x.user.email.toLowerCase() === want
    );
    if (!m) throw new Error('There is no staff member with this e-mail in this store.');
    return {
      userId: m.user.id,
      email: m.user.email,
      name: `${m.user.firstName} ${m.user.lastName}`.trim(),
      since: new Date(m.createdAt).toISOString(),
    };
  },
  describe: (_ctx, _a, state) => {
    const st = state as { email: string; name: string };
    return {
      summary: pair(
        `شيل ${st.name || st.email} من فريق المتجر: هيفقد الدخول فورًا، وأي دعوة معلّقة ليه هتنتهي، ومفاتيح MCP بتاعته هتتلغي. لو عايزه يرجع لازم تبعتله دعوة جديدة.`,
        `Remove ${st.name || st.email} from the team: access ends at once, pending invitations expire and their MCP keys are revoked. To bring them back you must invite them again.`
      ),
      rows: [row('الموظف', 'Team member', `${st.name} <${st.email}>`, null)],
      affectedCount: 1,
    };
  },
  run: (ctx, _a, state) => removeStaffFromStore(ctx.storeId, (state as { userId: string }).userId),
});

export function accountBillingTools(): ToolSpec[] {
  return [
    billingOverview,
    billingInvoices,
    myFeatures,
    listMyStores,
    merchantMcpStatus,
    planChange,
    subscriptionCancel,
    subscriptionResume,
    instapayPlanChoose,
    storeGoLive,
    mcpSwitch,
    staffRemove,
  ];
}
