/**
 * Wave 2 (plan 4 C2): returns. Decisions that email the shopper and the refund that moves money are confirm class and irreversible; the return policy
 * text/window is a reversible preview. Each calls the SAME ReturnService / StoreService method the admin route calls (routes/return.routes.ts,
 * routes/store.routes.ts) and the Merchant MCP precedent (admin_approve_return / admin_reject_return / admin_complete_return).
 * The return id is not a `refs` kind: state() resolves it through the store-scoped ReturnService.getById, which 404s another store's id.
 */
import type { ToolSpec, TurnCtx } from '@ebda/shared/smart-layer';
import { isGatewayRefundMethod } from '../../lib/refund-methods';
import { ReturnService, REFUND_METHODS } from '../../services/return.service';
import { StoreService } from '../../services/store.service';
import { AppError } from '../../middleware/error-handler';
import { change, egp, f, pair, row, shape } from './kit';
import { keyedTool } from './store-settings.tools';

// return.routes.ts POST /admin/:id/approve|reject: requirePermission('returns:write') + requireFeature('returns')
const RETURN_GATE = { permission: 'returns:write', feature: 'returns' } as const;

async function readReturn(ctx: TurnCtx, returnId: string) {
  const r = await ReturnService.getById(ctx.storeId, returnId);
  return {
    returnId: r.id,
    returnNumber: r.returnNumber,
    status: String(r.status),
    orderNumber: r.order?.orderNumber ?? null,
    itemCount: r.items.length,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  };
}
type ReturnState = Awaited<ReturnType<typeof readReturn>>;
const mustBe = (s: ReturnState, ...ok: string[]) => {
  if (!ok.includes(s.status))
    throw new AppError(
      400,
      'INVALID_STATUS',
      `Return ${s.returnNumber} is ${s.status}; expected ${ok.join(' or ')}`
    );
};

const approve = change<{ returnId: string; notes?: string }>({
  name: 'return_approve',
  capabilityId: 'returns.manage',
  description:
    "Approve a customer's return request. The customer is emailed and it cannot be undone. Moves no money.",
  schema: shape(
    {
      returnId: f.id('The return request id.'),
      notes: f.text('Note kept on the return.', { max: 1000 }),
    },
    ['returnId']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  messagesCustomers: true,
  gate: RETURN_GATE,
  audit: { action: 'return.approved', resourceType: 'return', resourceId: a => a.returnId },
  state: (ctx, a) => readReturn(ctx, a.returnId),
  describe: (_ctx, a, st) => {
    const s = st as ReturnState;
    mustBe(s, 'pending');
    return {
      summary: pair(
        `هوافق على طلب المرتجع ${s.returnNumber} (${s.itemCount} صنف). العميل هيوصله إيميل، والقرار ده مينفعش يترجع.`,
        `Approve return ${s.returnNumber} (${s.itemCount} item(s)). The customer is emailed and this cannot be undone.`
      ),
      rows: [
        row('المرتجع', 'Return', s.returnNumber, s.returnNumber),
        row('الحالة', 'Status', s.status, 'approved'),
        row('إيميل للعميل', 'Email to the customer', null, 'هيتبعت / will be sent'),
        ...(a.notes ? [row('ملاحظتك', 'Your note', null, a.notes)] : []),
      ],
      affectedCount: 1,
    };
  },
  run: (ctx, a) => ReturnService.approve(ctx.storeId, a.returnId, ctx.userId, a.notes),
});

const reject = change<{ returnId: string; reason: string }>({
  name: 'return_reject',
  capabilityId: 'returns.manage',
  description:
    "Reject a customer's return request with a reason. The reason is emailed to the customer exactly as written and it cannot be undone.",
  schema: shape(
    {
      returnId: f.id('The return request id.'),
      reason: f.str('Reason shown to the customer.', { max: 1000 }),
    },
    ['returnId', 'reason']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  messagesCustomers: true,
  gate: RETURN_GATE,
  audit: { action: 'return.rejected', resourceType: 'return', resourceId: a => a.returnId },
  state: (ctx, a) => readReturn(ctx, a.returnId),
  describe: (_ctx, a, st) => {
    const s = st as ReturnState;
    mustBe(s, 'pending');
    return {
      summary: pair(
        `هرفض طلب المرتجع ${s.returnNumber}. السبب هيتبعت للعميل بالنص ده بالظبط، والقرار مينفعش يترجع.`,
        `Reject return ${s.returnNumber}. The reason is emailed to the customer as written; this cannot be undone.`
      ),
      rows: [
        row('المرتجع', 'Return', s.returnNumber, s.returnNumber),
        row('الحالة', 'Status', s.status, 'rejected'),
        row('السبب اللي هيوصل للعميل', 'Reason the customer will read', null, a.reason),
      ],
      affectedCount: 1,
    };
  },
  run: (ctx, a) => ReturnService.reject(ctx.storeId, a.returnId, ctx.userId, a.reason),
});

type RefundState = ReturnState & {
  recordedAmount: number;
  gateway: { available: boolean; amount: number | null; unavailableReason: string | null };
  storeCreditToWallet: number;
};
const completeRefund = change<{ returnId: string; refundMethod: string }>({
  name: 'return_complete_refund',
  capabilityId: 'returns.complete-refund',
  description:
    'Complete a received return and refund the customer with the chosen method (original payment gateway, store credit, or a manual method you handle yourself). Moves real money and cannot be undone. The amount is worked out by the store from the return; you cannot type one.',
  schema: shape(
    {
      returnId: f.id('The return request id.'),
      refundMethod: f.enum(
        REFUND_METHODS as unknown as [string, ...string[]],
        'How the money goes back.'
      ),
    },
    ['returnId', 'refundMethod']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  messagesCustomers: true,
  // return.routes.ts POST /admin/:id/complete is returns:write + returns, and a gateway / store_credit method also needs orders:refund (staff lack it).
  // The registry limits this capability to the owner, so the whole tool needs orders:refund (never looser than the route for any method).
  gate: { permission: 'orders:refund', feature: 'returns' },
  audit: { action: 'return.completed', resourceType: 'return', resourceId: a => a.returnId },
  state: async (ctx, a): Promise<RefundState> => {
    const base = await readReturn(ctx, a.returnId);
    const p = (await ReturnService.refundPreview(ctx.storeId, a.returnId)) as unknown as Omit<
      RefundState,
      keyof ReturnState
    >;
    return {
      ...base,
      recordedAmount: p.recordedAmount,
      gateway: {
        available: !!p.gateway?.available,
        amount: p.gateway?.amount ?? null,
        unavailableReason: p.gateway?.unavailableReason ?? null,
      },
      storeCreditToWallet: p.storeCreditToWallet ?? 0,
    };
  },
  describe: (_ctx, a, st) => {
    const s = st as RefundState;
    mustBe(s, 'received', 'inspecting');
    let amount: number;
    if (isGatewayRefundMethod(a.refundMethod)) {
      if (!s.gateway.available || s.gateway.amount === null)
        throw new AppError(
          409,
          s.gateway.unavailableReason ?? 'GATEWAY_REFUND_UNAVAILABLE',
          'The original payment method cannot be refunded for this return; choose another method.'
        );
      amount = s.gateway.amount;
    } else if (a.refundMethod === 'store_credit') {
      amount = s.storeCreditToWallet;
    } else {
      amount = s.recordedAmount;
    }
    return {
      summary: pair(
        `هكمّل المرتجع ${s.returnNumber} وأرجّع ${egp(amount)} ج.م للعميل عن طريق «${a.refundMethod}». دي فلوس حقيقية والعملية مينفعش تترجع.`,
        `Complete return ${s.returnNumber} and refund ${egp(amount)} EGP via ${a.refundMethod}. This moves real money and cannot be undone.`
      ),
      rows: [
        row('المرتجع', 'Return', s.returnNumber, s.returnNumber),
        row('الأوردر', 'Order', s.orderNumber, s.orderNumber),
        row('طريقة الاسترداد', 'Refund method', null, a.refundMethod),
        row('المبلغ (ج.م)', 'Amount (EGP)', null, egp(amount)),
        row('الحالة', 'Status', s.status, 'completed'),
      ],
      affectedCount: 1,
    };
  },
  run: (ctx, a) => ReturnService.complete(ctx.storeId, a.returnId, ctx.userId, a.refundMethod),
});

// store.routes.ts PUT /stores/:id (returnWindowDays, returnFeesPaidBy): authorize('store_admin', 'super_admin'); the shipping page's ReturnPolicyCard.
const policy = keyedTool({
  name: 'returns_policy_set',
  capabilityId: 'returns.policy',
  description:
    'Set the store return policy: how many days a customer has to return an item (0 means returns are not accepted) and who pays the return shipping (merchant or customer). null clears the declared policy.',
  fields: {
    returnWindowDays: f.nullable(
      f.int('Return window in days; 0 = returns not accepted.', { min: 0, max: 3650 })
    ),
    returnFeesPaidBy: f.nullable(f.enum(['merchant', 'customer'], 'Who pays return shipping.')),
  },
  labels: {
    returnWindowDays: ['مدة الارجاع (أيام)', 'Return window (days)'],
    returnFeesPaidBy: ['مين بيدفع شحن المرتجع', 'Who pays return shipping'],
  },
  select: { returnWindowDays: true, returnFeesPaidBy: true },
  current: r => ({
    returnWindowDays: r.returnWindowDays ?? null,
    returnFeesPaidBy: r.returnFeesPaidBy ?? null,
  }),
  audit: 'store.return_policy.updated',
  summary: pair('هعدّل سياسة الاسترجاع', 'Update the return policy'),
  run: (ctx, patch) => StoreService.update(ctx.storeId, patch as never),
});

export function returnsTools(): ToolSpec[] {
  return [approve, reject, completeRefund, policy];
}
