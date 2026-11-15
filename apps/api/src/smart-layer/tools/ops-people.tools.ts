/**
 * Phase E2 ops tools, people and settings side: the two free payment reads, customer block and erase, gold rates, wholesale decisions and the Customer Intelligence switches.
 */
import { z } from 'zod/v3';
import { withStore } from '@ebda/database';
import { ToolForbidden, type ToolSpec, type TurnCtx } from '@ebda/shared/smart-layer';
import { storeDb } from '../../lib/repo-factory';
import { readInStoreContext } from '../../lib/store-scoped-read';
import { deferAfterTenantCommit } from '../../lib/after-tenant-commit';
import { invalidateCustomersCache } from '../../lib/public-cache';
import { customerRow } from '../../lib/customer-directory';
import { assertStoreCustomer, storeCustomerWhere } from '../../lib/store-customer';
import logger from '../../lib/logger';
import { AppError } from '../../middleware/error-handler';
import { featureService } from '../../services/feature.service';
import { AuthService } from '../../services/auth.service';
import { GoldRateService } from '../../services/gold-rate/gold-rate.service';
import { setCiSharing } from '../../services/ci-hints.service';
import { WholesaleApplicationService } from '../../services/wholesale-application.service';
import { change, egp, f, pair, row, shape } from './kit';
import {
  OWNER,
  OWNER_OR_STAFF,
  iso,
  notFound,
  toPiasters,
  untrusted,
  type Rec,
} from './ops-shared';

// ======================================================================================================================================
// Free reads
// ======================================================================================================================================
const readBase = { policy: 'free' as const, undo: 'none' as const };

const abandonments: ToolSpec = {
  ...readBase,
  name: 'payment_abandonments_list',
  // payment-abandonments.routes.ts GET /: authorize('store_admin','super_admin','staff') + requireFeature('payment_abandonment'). No contact data is returned.
  capabilityId: 'payment.abandonments',
  description:
    'Who started paying online and left without finishing (abandoned payments): the count, the total value and the 10 latest orders with their order number, amount, payment method and when they left. Use for "who started paying and did not complete", "payment abandonment", "الدفع اللي ماكملش", "مين بدأ يدفع وسابه". Contact details are not included.',
  resultTrust: 'store-data',
  args: z.object({ days: z.number().int().min(1).max(90).optional() }).strict(),
  jsonSchema: {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 90,
        description: 'Look back this many days (default 30).',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async read(ctx: TurnCtx, a: unknown) {
    if (!(OWNER_OR_STAFF as readonly string[]).includes(ctx.role)) throw new ToolForbidden();
    if (!(await featureService.isFeatureEnabled(ctx.storeId, 'payment_abandonment')))
      throw new ToolForbidden();
    const days = (a as { days?: number }).days ?? 30;
    const since = new Date(ctx.now - days * 86_400_000);
    return readInStoreContext(ctx.storeId, async () => {
      const db = await storeDb(ctx.storeId);
      const where = {
        storeId: ctx.storeId,
        deletedAt: null,
        paymentGatewayAbandonedAt: { gte: since },
      };
      const [count, rows] = await Promise.all([
        db.order.count({ where }),
        db.order.findMany({
          where,
          orderBy: { paymentGatewayAbandonedAt: 'desc' },
          take: 10,
          select: {
            orderNumber: true,
            status: true,
            paymentStatus: true,
            total: true,
            currency: true,
            paymentGatewayAbandonedAt: true,
            payments: { select: { provider: true }, take: 1, orderBy: { createdAt: 'desc' } },
          },
        }),
      ]);
      return {
        days,
        abandonedCount: count,
        latest: rows.map(r => ({
          orderNumber: r.orderNumber,
          status: String(r.status),
          paymentStatus: String(r.paymentStatus),
          totalEgp: egp(r.total as number),
          provider: r.payments[0]?.provider ?? null,
          leftAt: iso(r.paymentGatewayAbandonedAt),
        })),
      };
    });
  },
};

const paymentEvents: ToolSpec = {
  ...readBase,
  name: 'payment_events_for_order',
  // payment.routes.ts GET /order/:orderId + GET /:id/events: the store's owner (or its staff) reads the payment and its append-only event log.
  capabilityId: 'payment.events',
  description:
    'The payments of one order and what happened to each (created, paid, failed, refunded...), newest first. Use when a customer says "I paid but the order shows unpaid", "what is the payment status of this order", "العميل بيقول دفع وماوصلنيش", "حالة الدفع". The raw provider payload is never returned.',
  resultTrust: 'store-data',
  args: z.object({ orderId: z.string().trim().min(1).max(64) }).strict(),
  jsonSchema: {
    type: 'object',
    properties: { orderId: { type: 'string', maxLength: 64, description: 'The order id.' } },
    required: ['orderId'],
    additionalProperties: false,
  },
  refs: (a: unknown) => [{ kind: 'order', id: (a as { orderId: string }).orderId }],
  async read(ctx: TurnCtx, a: unknown) {
    if (!(OWNER_OR_STAFF as readonly string[]).includes(ctx.role)) throw new ToolForbidden();
    const { orderId } = a as { orderId: string };
    return readInStoreContext(ctx.storeId, async () => {
      const db = await storeDb(ctx.storeId);
      const payments = await db.payment.findMany({
        where: { orderId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          provider: true,
          method: true,
          status: true,
          amount: true,
          refundedAmount: true,
          createdAt: true,
        },
      });
      const out = [];
      for (const p of payments) {
        const events = await db.paymentEvent.findMany({
          where: { storeId: ctx.storeId, paymentId: p.id },
          orderBy: { occurredAt: 'desc' },
          take: 10,
          select: {
            eventType: true,
            fromStatus: true,
            toStatus: true,
            provider: true,
            occurredAt: true,
          },
        });
        out.push({
          provider: p.provider,
          method: p.method,
          status: String(p.status),
          amountEgp: egp(p.amount),
          refundedEgp: egp(p.refundedAmount),
          createdAt: iso(p.createdAt),
          events: events.map(e => ({
            type: e.eventType,
            from: e.fromStatus,
            to: e.toStatus,
            at: iso(e.occurredAt),
          })),
        });
      }
      return { payments: out };
    });
  },
};

// ======================================================================================================================================
// customers.erase-block
// ======================================================================================================================================
async function readShopper(storeId: string, customerId: string) {
  await assertStoreCustomer(storeId, customerId); // 404 for no such id, a staff id and another store's shopper alike
  const d = await customerRow(storeId, customerId);
  if (d)
    return {
      customerId,
      name: `${d.firstName} ${d.lastName}`.trim(),
      status: d.status,
      deleted: d.deletedAt !== null,
    };
  const u = await withStore(storeId, tx =>
    tx.user.findFirst({
      where: storeCustomerWhere(storeId, customerId),
      select: { status: true, firstName: true, lastName: true, deletedAt: true },
    })
  );
  if (!u) throw notFound('Customer');
  return {
    customerId,
    name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(),
    status: String(u.status),
    deleted: u.deletedAt !== null,
  };
}
type ShopperState = Awaited<ReturnType<typeof readShopper>>;
const STATUS_AR: Record<string, string> = { active: 'شغال', inactive: 'متوقف', suspended: 'محظور' };

const setCustomerStatus = change<{ customerId: string; status: string }>({
  name: 'customer_set_status',
  capabilityId: 'customers.erase-block',
  description:
    'Block (suspend), deactivate or re-activate a customer account of this store: a blocked customer is signed out at once and cannot log in. Use for "block this customer", "ابلوك عميل", "فك الحظر". To reverse it, run it again with status active.',
  schema: shape(
    {
      customerId: f.id('The customer (shopper account) id.'),
      status: f.enum(
        ['active', 'inactive', 'suspended'],
        'active = allowed, suspended = blocked, inactive = switched off.'
      ),
    },
    ['customerId', 'status']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  // customers.routes.ts PUT /customers/:customerId/status: authorize('store_admin','super_admin') + requirePermission('users:write'), never staff.
  gate: { roles: OWNER, permission: 'users:write' },
  audit: {
    action: 'customer.status.changed_by_merchant',
    resourceType: 'user',
    resourceId: a => a.customerId,
  },
  state: (ctx, a) => readShopper(ctx.storeId, a.customerId),
  describe: (_ctx, a, st) => {
    const s = st as ShopperState;
    if (s.deleted)
      throw new AppError(409, 'CUSTOMER_DELETED', 'This customer account was already deleted.');
    return {
      summary: pair(
        `هغيّر حالة حساب العميل ${s.name || s.customerId} من «${STATUS_AR[s.status] ?? s.status}» إلى «${STATUS_AR[a.status] ?? a.status}». لو اتحظر هيتفصل فورًا.`,
        `Change the account of ${s.name || s.customerId} from ${s.status} to ${a.status}. A blocked customer is signed out at once.`
      ),
      rows: [
        row('العميل', 'Customer', s.name, s.name),
        row('الحالة', 'Status', s.status, a.status),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    await AuthService.setCustomerStatus(
      a.customerId,
      ctx.storeId,
      a.status as 'active' | 'inactive' | 'suspended'
    );
    return { customerId: a.customerId, status: a.status };
  },
});

const eraseCustomer = change<{ customerId: string }>({
  name: 'customer_erase',
  capabilityId: 'customers.erase-block',
  description:
    'Erase a customer\'s personal data (right to erasure) when they ask to be forgotten: name, contact details and addresses are anonymised, orders stay for the accounts. Deletes data, cannot be undone. Use for "this customer asked me to delete their data", "امسح بيانات العميل".',
  schema: shape({ customerId: f.id('The customer (shopper account) id.') }, ['customerId']),
  policy: 'confirm',
  undo: 'irreversible',
  deletes: true,
  // customers.routes.ts POST /customers/:customerId/erase: authorize('store_admin','super_admin'), never staff, never while impersonating (privacyMiddleware).
  gate: { roles: OWNER },
  audit: {
    action: 'customer.account.erased_by_merchant',
    resourceType: 'user',
    resourceId: a => a.customerId,
  },
  state: (ctx, a) => readShopper(ctx.storeId, a.customerId),
  describe: (_ctx, _a, st) => {
    const s = st as ShopperState;
    return {
      summary: pair(
        `هامسح بيانات العميل ${s.name || s.customerId} نهائيًا (الاسم والتليفون والإيميل والعناوين). الأوردرات هتفضل للحسابات من غير بياناته. مينفعش يترجع.`,
        `Permanently erase the personal data of ${s.name || s.customerId} (name, phone, email, addresses). Orders stay for the accounts without their details. This cannot be undone.`
      ),
      rows: [
        row('العميل', 'Customer', s.name, null),
        row('البيانات الشخصية', 'Personal data', 'موجودة / present', 'هتتمسح / erased'),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const outcome = await AuthService.eraseAccount(a.customerId, {
      scopeStoreId: ctx.storeId,
      actorId: ctx.userId,
      storeHint: ctx.storeId,
    });
    // after COMMIT, never inside the request transaction (the customers list must not re-cache the pre-erasure PII)
    void deferAfterTenantCommit('customers.erase.invalidateCache', () =>
      invalidateCustomersCache(ctx.storeId)
    ).catch(err =>
      logger.warn(
        { err, storeId: ctx.storeId },
        '[assistant.customer_erase] cache invalidation failed'
      )
    );
    return { crmReviewNeeded: outcome.crmChecked && outcome.crmAmbiguous };
  },
});

// ======================================================================================================================================
// store.gold-rates
// ======================================================================================================================================
type GoldArgs = { rates: Array<{ karat: number; ratePerGramEgp: number }> };
type GoldState = { rates: Array<{ karat: number; ratePerGram: number | null }>; jumpBps: number };
const goldRates = change<GoldArgs>({
  name: 'gold_rate_set',
  capabilityId: 'store.gold-rates',
  description:
    'Set today\'s gold price per gram in EGP (a decimal number, not piasters) for 24, 21 and/or 18 karat. Every product priced by the gold rate is repriced at once, so this changes what shoppers pay. Use for "update the gold price", "حدّث سعر الدهب", "عيار 21 بقى 4000". Undo puts the previous rates back (also repricing).',
  schema: shape(
    {
      rates: f.list(
        f.obj(
          {
            karat: f.int('24, 21 or 18.', { min: 18, max: 24 }),
            ratePerGramEgp: f.num('Price of one gram in EGP.', { max: 10_000_000 }),
          },
          ['karat', 'ratePerGramEgp']
        ),
        { min: 1, max: 3 }
      ),
    },
    ['rates']
  ),
  policy: 'confirm',
  undo: 'compensating',
  money: true,
  // gold-rate.routes.ts PUT /: authorize('store_admin','super_admin','staff') + requirePermission('store:settings') (staff lack it).
  gate: { permission: 'store:settings' },
  audit: { action: 'gold_rate.set', resourceType: 'gold_rate' },
  state: async (ctx): Promise<GoldState> => {
    const g = await GoldRateService.getState(ctx.storeId);
    return {
      rates: g.rates.map(r => ({ karat: r.karat as number, ratePerGram: r.ratePerGram })),
      jumpBps: g.settings.jumpConfirmBps ?? 500,
    };
  },
  describe: (_ctx, a, st) => {
    const s = st as GoldState;
    const rows = a.rates.map(r => {
      const before = s.rates.find(x => x.karat === r.karat)?.ratePerGram ?? null;
      const afterMinor = toPiasters(r.ratePerGramEgp);
      const pct = before ? Math.round(((afterMinor - before) / before) * 1000) / 10 : null;
      return { r, before, afterMinor, pct };
    });
    const big = rows.filter(x => x.pct !== null && Math.abs(x.pct) * 100 >= s.jumpBps);
    return {
      summary: pair(
        `هحدّث سعر جرام الدهب (${rows.map(x => `عيار ${x.r.karat}: ${x.r.ratePerGramEgp} ج.م`).join('، ')}). كل المنتجات المسعّرة بالدهب هتتسعّر من جديد فورًا.`,
        `Set the gold price per gram (${rows.map(x => `${x.r.karat}k: ${x.r.ratePerGramEgp} EGP`).join(', ')}). Every gold-priced product is repriced at once.`
      ),
      rows: [
        ...rows.map(x =>
          row(
            `عيار ${x.r.karat} (ج.م/جرام)`,
            `${x.r.karat}k (EGP/gram)`,
            egp(x.before),
            egp(x.afterMinor)
          )
        ),
        ...big.map(x =>
          row(
            `تنبيه: تغيير كبير في عيار ${x.r.karat}`,
            `Warning: big jump on ${x.r.karat}k`,
            null,
            `${x.pct}%`
          )
        ),
      ],
      affectedCount: rows.length,
      changesPrice: true,
      restore: {
        rates: rows
          .filter(x => x.before !== null)
          .map(x => ({ karat: x.r.karat, ratePerGramEgp: (x.before as number) / 100 })),
      },
    };
  },
  // the merchant approved the card, which shows any jump over the store's gate: `confirm: true` is that approval (Ruling B5-20)
  run: (ctx, a) =>
    GoldRateService.applyRates(
      ctx.storeId,
      {
        rates: a.rates.map(r => ({
          karat: r.karat as 24 | 21 | 18,
          ratePerGram: toPiasters(r.ratePerGramEgp),
        })),
        confirm: true,
      },
      { userId: ctx.userId }
    ),
  inverse: (_a, restore) => {
    const rates = (restore as GoldArgs | null)?.rates ?? [];
    return rates.length ? { tool: 'gold_rate_set', args: { rates } } : null;
  },
});

// ======================================================================================================================================
// marketing.wholesale
// ======================================================================================================================================
// wholesale.routes.ts: authorize('store_admin','super_admin') + requireStoreAccess; approve / reject need requireFeature('b2b.wholesale'), revoke does not.
async function readApplication(ctx: TurnCtx, id: string) {
  const db = await storeDb(ctx.storeId);
  const app = await db.wholesaleApplication.findFirst({
    where: { id, storeId: ctx.storeId },
    select: {
      id: true,
      businessName: true,
      status: true,
      groupId: true,
      decidedAt: true,
      updatedAt: true,
    },
  });
  if (!app) throw notFound('Application');
  return {
    applicationId: app.id,
    businessName: app.businessName,
    status: String(app.status),
    groupId: app.groupId ?? null,
    updatedAt: iso(app.updatedAt),
  };
}
type AppState = Awaited<ReturnType<typeof readApplication>>;
const decide = change<{ applicationId: string; decision: string; groupId?: string; note?: string }>(
  {
    name: 'wholesale_decide',
    capabilityId: 'marketing.wholesale',
    description:
      'Approve or reject a wholesale (B2B) buyer application. Approve needs the wholesale customer group the buyer joins (it gives them that group\'s prices); the applicant is emailed either way (a rejection carries your note as written, an approval has no note), and it cannot be undone. Use for "accept the wholesale request", "اقبل طلب تاجر جملة", "ارفض طلب الجملة".',
    schema: shape(
      {
        applicationId: f.id('The wholesale application id.'),
        decision: f.enum(['approve', 'reject'], 'approve or reject.'),
        groupId: f.id('Wholesale customer group id (required to approve).'),
        note: f.str('Note emailed to the applicant (a rejection only; an approval sends none).', {
          max: 500,
        }),
      },
      ['applicationId', 'decision']
    ),
    policy: 'confirm',
    undo: 'irreversible',
    messagesCustomers: true,
    gate: { roles: OWNER, feature: 'b2b.wholesale' },
    audit: {
      action: 'wholesale.decided',
      resourceType: 'wholesale_application',
      resourceId: a => a.applicationId,
    },
    state: (ctx, a) => readApplication(ctx, a.applicationId),
    describe: async (ctx, a, st) => {
      const s = st as AppState;
      if (s.status !== 'pending')
        throw new AppError(409, 'NOT_PENDING', 'This application was already decided.');
      // WholesaleApplicationService.approve takes no note: a note on an approve would be shown on the card and never sent.
      if (a.decision === 'approve' && a.note)
        throw new AppError(
          422,
          'NOTE_NOT_SENT_ON_APPROVE',
          'An approval sends no note; only a rejection can carry one.'
        );
      let groupName: string | null = null;
      if (a.decision === 'approve') {
        if (!a.groupId)
          throw new AppError(
            422,
            'GROUP_REQUIRED',
            'Approving needs the wholesale customer group.'
          );
        const g = await (
          await storeDb(ctx.storeId)
        ).customerGroup.findFirst({
          where: { id: a.groupId, storeId: ctx.storeId },
          select: { name: true },
        });
        if (!g) throw notFound('Customer group');
        groupName = g.name;
      }
      const word = a.decision === 'approve' ? ['هوافق على', 'Approve'] : ['هرفض', 'Reject'];
      return {
        summary: pair(
          `${word[0]} طلب الجملة بتاع «${s.businessName}»${groupName ? ` وأضيفه لمجموعة «${groupName}»` : ''}. التاجر هيوصله إيميل ومينفعش يترجع.`,
          `${word[1]} the wholesale application of "${s.businessName}"${groupName ? ` and add them to "${groupName}"` : ''}. The applicant is emailed and this cannot be undone.`
        ),
        rows: [
          untrusted(row('التاجر', 'Applicant', s.businessName, s.businessName)),
          row('القرار', 'Decision', s.status, a.decision === 'approve' ? 'approved' : 'rejected'),
          ...(groupName ? [row('مجموعة الجملة', 'Wholesale group', null, groupName)] : []),
          ...(a.decision === 'reject' && a.note
            ? [row('ملاحظتك للتاجر', 'Your note to the applicant', null, a.note)]
            : []),
        ],
        affectedCount: 1,
      };
    },
    run: async (ctx, a) => {
      const app =
        a.decision === 'approve'
          ? await WholesaleApplicationService.approve(
              ctx.storeId,
              a.applicationId,
              a.groupId as string,
              ctx.userId
            )
          : await WholesaleApplicationService.reject(
              ctx.storeId,
              a.applicationId,
              a.note ?? null,
              ctx.userId
            );
      return { status: String((app as { status?: string }).status ?? '') };
    },
  }
);

const revoke = change<{ applicationId: string; note?: string }>({
  name: 'wholesale_revoke',
  capabilityId: 'marketing.wholesale',
  description:
    'End an approved wholesale buyer\'s access: they go back to retail prices at once. The buyer would have to apply again after the cooldown, so it cannot be undone from here. Use for "remove this wholesale buyer", "الغي تاجر الجملة ده".',
  schema: shape(
    {
      applicationId: f.id('The approved wholesale application id.'),
      note: f.str('Internal note (optional).', { max: 500 }),
    },
    ['applicationId']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  gate: { roles: OWNER },
  audit: {
    action: 'wholesale.revoked',
    resourceType: 'wholesale_application',
    resourceId: a => a.applicationId,
  },
  state: (ctx, a) => readApplication(ctx, a.applicationId),
  describe: (_ctx, a, st) => {
    const s = st as AppState;
    if (s.status !== 'approved')
      throw new AppError(409, 'NOT_APPROVED', 'Only an approved application can be revoked.');
    return {
      summary: pair(
        `هلغي وصول تاجر الجملة «${s.businessName}»، هيرجع للسعر العادي فورًا.`,
        `Revoke wholesale access of "${s.businessName}"; they go back to retail prices at once.`
      ),
      rows: [
        untrusted(row('التاجر', 'Buyer', s.businessName, s.businessName)),
        row('الحالة', 'Status', s.status, 'revoked'),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const r = await WholesaleApplicationService.revoke(
      ctx.storeId,
      a.applicationId,
      a.note ?? null,
      ctx.userId
    );
    return { membership: r.membership };
  },
});

// ======================================================================================================================================
// shipping.customer-intelligence
// ======================================================================================================================================
type CiArgs = { hints?: boolean; sharing?: boolean };
// ci.routes.ts PUT /:storeId/ci/hints and /ci/sharing: authorize('store_admin','super_admin') + requireStoreAccess (no feature gate on the switches).
const ciSettings = change<CiArgs>({
  name: 'customer_intelligence_settings',
  capabilityId: 'shipping.customer-intelligence',
  description:
    'Turn the smart order hints on or off (cash-on-delivery risk notes and the best courier for an area) and the cross-store sharing opt-in. Use for "turn on smart hints", "فعّل التلميحات الذكية", "عميل ده خطر COD".',
  schema: shape(
    {
      hints: f.bool('true turns the smart hints on, false off.'),
      sharing: f.bool('true opts the store in to anonymous cross-store signals, false opts out.'),
    },
    []
  ),
  undo: 'reversible',
  gate: { roles: OWNER },
  audit: { action: 'store.ci_settings_changed', resourceType: 'store' },
  state: async ctx => {
    const db = await storeDb(ctx.storeId);
    const st = await db.store.findFirst({
      where: { id: ctx.storeId },
      select: { ciSharing: true },
    });
    if (!st) throw notFound('Store');
    return {
      hints: await featureService.isFeatureEnabled(ctx.storeId, 'customer_intelligence'),
      sharing: Boolean(st.ciSharing),
    };
  },
  describe: (_ctx, a, st) => {
    const cur = st as { hints: boolean; sharing: boolean };
    const keys = (['hints', 'sharing'] as const).filter(k => a[k] !== undefined);
    if (keys.length === 0)
      throw new AppError(400, 'NOTHING_TO_CHANGE', 'Send hints and/or sharing.');
    const label = {
      hints: ['التلميحات الذكية', 'Smart hints'],
      sharing: ['مشاركة الإشارات بين المتاجر', 'Cross-store sharing'],
    } as const;
    return {
      summary: pair('هعدّل إعدادات التلميحات الذكية', 'Update the smart hints settings'),
      rows: keys.map(k => row(label[k][0], label[k][1], cur[k], a[k])),
      affectedCount: 1,
      restore: Object.fromEntries(keys.map(k => [k, cur[k]])),
    };
  },
  run: async (ctx, a) => {
    if (a.hints !== undefined)
      await featureService.setFeature(ctx.storeId, 'customer_intelligence', a.hints, ctx.userId);
    if (a.sharing !== undefined) await setCiSharing(ctx.storeId, a.sharing);
    return {};
  },
  inverse: (_a, restore) =>
    restore && Object.keys(restore as Rec).length > 0
      ? { tool: 'customer_intelligence_settings', args: restore }
      : null,
});

export function opsPeopleTools(): ToolSpec[] {
  return [
    abandonments,
    paymentEvents,
    setCustomerStatus,
    eraseCustomer,
    goldRates,
    decide,
    revoke,
    ciSettings,
  ];
}
