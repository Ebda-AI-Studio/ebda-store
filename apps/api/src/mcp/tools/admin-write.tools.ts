import { z, type ZodRawShape } from 'zod/v3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from '../resolve-store';
import { OrderService } from '../../services/order.service';
import { ProductService } from '../../services/product.service';
import { InventoryService } from '../../services/inventory.service';
import { CouponService } from '../../services/coupon.service';
import { ReturnService, REFUND_METHODS } from '../../services/return.service';
import { isGatewayRefundMethod } from '../../lib/refund-methods';
import { createProductSchemaChecked, updateProductSchema } from '../../routes/product.routes';
import { createCouponSchema, updateCouponSchema } from '../../routes/coupon.routes';
import { adjustInventorySchema, setInventorySchema } from '../../routes/inventory.routes';
import { hasPermission, type Role } from '../../middleware/rbac';
import type { InventoryChangeType } from '@ebda/database';
import { registerMerchantWriteTool, type WriteToolSpec } from '../merchant-write';

/**
 * The merchant-admin MCP WRITE surface (Ahmad, 2026-10-10, binding decision 4).
 *
 * Every tool is a thin declaration over `registerMerchantWriteTool`
 * (merchant-write.ts), which owns scope, store match, plan + merchant switch,
 * RBAC, the destructive confirm round-trip, fail-closed audit (actor=mcp) and
 * the tenant context. A tool's `run` calls the SAME service method, with the
 * SAME exported Zod schema, the matching admin route calls — never a copy of
 * business logic, never a bypass of validation.
 *
 * `permission` / `roles` / `feature` mirror, line for line, the guards on the
 * admin route (cited per tool). Operations whose logic still lives INLINE in a
 * route handler (categories, order refund-via-provider, mark-paid, pages,
 * shipping, store settings, customers) are deliberately NOT exposed until that
 * logic is extracted to a service — see docs in
 * apps/help/content/en/merchant-mcp-write-tools.mdx ("Not available yet").
 */

const orderStatusAdvance = z.enum(['confirmed', 'processing', 'shipped', 'delivered']);

const WRITE_TOOLS: WriteToolSpec<ZodRawShape>[] = [
  // ── Orders ────────────────────────────────────────────────────────────────
  {
    // order.routes.ts PUT /:id/status — authorize(store_admin, super_admin, staff) + orders:manage
    name: 'admin_update_order_status',
    description:
      'Advance an order to confirmed, processing, shipped, or delivered. Not for cancelling or ' +
      'refunding: use admin_cancel_order (cancel, confirm round-trip) or the return tools. Refused ' +
      'if the transition is not valid from the order’s current status.',
    input: { orderId: z.string().min(1), status: orderStatusAdvance },
    roles: ['store_admin', 'staff'], // ORDER-MONEY-SUPERADMIN (#68): never super_admin
    permission: 'orders:manage',
    audit: {
      action: 'order.status_updated',
      resourceType: 'order',
      resourceId: a => a.orderId,
      details: (a, r) => ({ toStatus: a.status, orderNumber: r?.orderNumber }),
    },
    run: async (a, ctx) => {
      const order: any = await ctx.inStore(() =>
        OrderService.updateStatus(ctx.store.id, a.orderId, a.status)
      );
      return { orderId: order.id, orderNumber: order.orderNumber, status: order.status };
    },
  },
  {
    // order.routes.ts PUT /:id/status with status=cancelled — same guards
    name: 'admin_cancel_order',
    description:
      'Cancel an order. DESTRUCTIVE: the first call changes nothing and returns a confirmToken and a ' +
      'summary; call again with the SAME arguments plus that token to cancel. Refused if the order ' +
      'cannot be cancelled from its current status. Does not refund money; refunds go through the ' +
      'return flow (admin_complete_return).',
    input: {
      orderId: z.string().min(1),
      restoreInventory: z.boolean().default(true).describe('Put the cancelled order’s stock back.'),
    },
    destructive: true,
    roles: ['store_admin', 'staff'], // ORDER-MONEY-SUPERADMIN (#68): never super_admin
    permission: 'orders:manage',
    audit: {
      action: 'order.cancelled',
      resourceType: 'order',
      resourceId: a => a.orderId,
      details: (a, r) => ({ restoreInventory: a.restoreInventory, orderNumber: r?.orderNumber }),
    },
    summarize: async (a, ctx) => {
      const o: any = await ctx.inStore(() => OrderService.getById(ctx.store.id, a.orderId));
      return (
        `Cancel order ${o.orderNumber} (status ${o.status}, total ${o.total}). ` +
        `Stock ${a.restoreInventory ? 'WILL' : 'will NOT'} be returned to inventory.`
      );
    },
    run: async (a, ctx) => {
      const o: any = await ctx.inStore(() =>
        OrderService.updateStatus(ctx.store.id, a.orderId, 'cancelled', {
          restoreInventory: a.restoreInventory,
        })
      );
      return { orderId: o.id, orderNumber: o.orderNumber, status: o.status };
    },
  },

  // ── Products ──────────────────────────────────────────────────────────────
  {
    // product.routes.ts POST / — products:write
    name: 'admin_create_product',
    description:
      'Create a product. `product` takes exactly the fields the dashboard product form sends ' +
      '(name, price, bilingual fields, images, variants, ...) and is validated by the same schema.',
    input: { product: createProductSchemaChecked },
    permission: 'products:write',
    audit: {
      action: 'product.created',
      resourceType: 'product',
      resourceId: (_a, r) => r?.productId,
      details: (_a, r) => ({ name: r?.name, sku: r?.sku }),
    },
    run: async (a, ctx) => {
      const p: any = await ctx.inStore(() => ProductService.create(ctx.store.id, a.product));
      return { productId: p.id, name: p.name, sku: p.sku, status: p.status };
    },
  },
  {
    // product.routes.ts PUT /:id — products:write
    name: 'admin_update_product',
    description:
      'Update a product. `changes` holds only the fields to change (same schema as the dashboard). ' +
      'Does not change stock; use admin_adjust_inventory / admin_set_inventory for that.',
    input: { productId: z.string().min(1), changes: updateProductSchema },
    permission: 'products:write',
    audit: {
      action: 'product.updated',
      resourceType: 'product',
      resourceId: a => a.productId,
      details: a => ({ changedFields: Object.keys(a.changes ?? {}).join(', ') }),
    },
    run: async (a, ctx) => {
      const p: any = await ctx.inStore(() =>
        ProductService.update(ctx.store.id, a.productId, a.changes)
      );
      return { productId: p.id, name: p.name, status: p.status };
    },
  },
  {
    // product.routes.ts DELETE /:id — products:delete
    name: 'admin_delete_product',
    description:
      'Delete a product. DESTRUCTIVE: the first call changes nothing and returns a confirmToken and ' +
      'a summary; call again with the SAME productId plus that token to delete.',
    input: { productId: z.string().min(1) },
    destructive: true,
    permission: 'products:delete',
    audit: {
      action: 'product.deleted',
      resourceType: 'product',
      resourceId: a => a.productId,
      details: (_a, r) => ({ name: r?.name }),
    },
    summarize: async (a, ctx) => {
      const p: any = await ctx.inStore(() => ProductService.getById(ctx.store.id, a.productId));
      return `Delete product "${p.name}" (SKU ${p.sku ?? 'none'}). It disappears from the storefront.`;
    },
    run: async (a, ctx) => {
      const p: any = await ctx.inStore(() => ProductService.getById(ctx.store.id, a.productId));
      await ctx.inStore(() => ProductService.delete(ctx.store.id, a.productId));
      return { productId: a.productId, name: p.name, deleted: true };
    },
  },

  // ── Inventory ─────────────────────────────────────────────────────────────
  {
    // inventory.routes.ts POST /adjust — authorize(store_admin, super_admin, staff) + inventory.basic
    name: 'admin_adjust_inventory',
    description:
      'Add or remove stock for a product by a signed quantity, with a type (manual_add, ' +
      'manual_remove, adjustment, damage, transfer_in, transfer_out) and an optional reason.',
    input: { adjustment: adjustInventorySchema },
    roles: ['store_admin', 'super_admin', 'staff'],
    feature: 'inventory.basic',
    audit: {
      action: 'inventory.adjusted',
      resourceType: 'product',
      resourceId: a => a.adjustment.productId,
      details: a => ({
        quantity: a.adjustment.quantity,
        type: a.adjustment.type,
        reason: a.adjustment.reason,
      }),
    },
    run: async (a, ctx) => {
      const r = await ctx.inStore(() =>
        InventoryService.adjustInventory(
          ctx.store.id,
          {
            productId: a.adjustment.productId,
            quantity: a.adjustment.quantity,
            type: a.adjustment.type as InventoryChangeType,
            reason: a.adjustment.reason,
            reference: a.adjustment.reference,
          },
          ctx.auth.userId
        )
      );
      return { result: r as unknown as Record<string, unknown> };
    },
  },
  {
    // inventory.routes.ts PUT /products/:productId/set — same guards
    name: 'admin_set_inventory',
    description:
      'Set a product’s stock to an exact quantity (a stock count correction), with an optional reason.',
    input: { productId: z.string().uuid(), ...setInventorySchema.shape },
    roles: ['store_admin', 'super_admin', 'staff'],
    feature: 'inventory.basic',
    audit: {
      action: 'inventory.set',
      resourceType: 'product',
      resourceId: a => a.productId,
      details: a => ({ quantity: a.quantity, reason: a.reason }),
    },
    run: async (a, ctx) => {
      const r = await ctx.inStore(() =>
        InventoryService.setInventory(
          ctx.store.id,
          a.productId,
          a.quantity,
          a.reason,
          ctx.auth.userId
        )
      );
      return { result: r as unknown as Record<string, unknown> };
    },
  },

  // ── Discounts / coupons ───────────────────────────────────────────────────
  {
    // coupon.routes.ts POST — authorize(store_admin, super_admin) + coupons
    name: 'admin_create_coupon',
    description:
      'Create a discount coupon (code, type percentage/fixed/free_shipping, value, limits, dates).',
    input: { coupon: createCouponSchema },
    roles: ['store_admin', 'super_admin'],
    feature: 'coupons',
    audit: {
      action: 'coupon.created',
      resourceType: 'coupon',
      resourceId: (_a, r) => r?.couponId,
      details: (_a, r) => ({ code: r?.code }),
    },
    run: async (a, ctx) => {
      const c: any = await ctx.inStore(() => CouponService.create(ctx.store.id, a.coupon));
      return { couponId: c.id, code: c.code, isActive: c.isActive };
    },
  },
  {
    // coupon.routes.ts PUT /:id — same guards
    name: 'admin_update_coupon',
    description: 'Update a coupon. `changes` holds only the fields to change.',
    input: { couponId: z.string().min(1), changes: updateCouponSchema },
    roles: ['store_admin', 'super_admin'],
    feature: 'coupons',
    audit: {
      action: 'coupon.updated',
      resourceType: 'coupon',
      resourceId: a => a.couponId,
      details: a => ({ changedFields: Object.keys(a.changes ?? {}).join(', ') }),
    },
    run: async (a, ctx) => {
      const c: any = await ctx.inStore(() =>
        CouponService.update(ctx.store.id, a.couponId, a.changes)
      );
      return { couponId: c.id, code: c.code, isActive: c.isActive };
    },
  },
  {
    // coupon.routes.ts PATCH /:id/toggle — same guards
    name: 'admin_toggle_coupon',
    description: 'Switch a coupon between active and inactive.',
    input: { couponId: z.string().min(1) },
    roles: ['store_admin', 'super_admin'],
    feature: 'coupons',
    audit: {
      action: 'coupon.toggled',
      resourceType: 'coupon',
      resourceId: a => a.couponId,
      details: (_a, r) => ({ isActive: r?.isActive }),
    },
    run: async (a, ctx) => {
      const c: any = await ctx.inStore(() => CouponService.toggleActive(ctx.store.id, a.couponId));
      return { couponId: c.id, code: c.code, isActive: c.isActive };
    },
  },
  {
    // coupon.routes.ts DELETE /:id — same guards
    name: 'admin_delete_coupon',
    description:
      'Delete a coupon. DESTRUCTIVE: the first call changes nothing and returns a confirmToken and a ' +
      'summary; call again with the SAME couponId plus that token to delete.',
    input: { couponId: z.string().min(1) },
    destructive: true,
    roles: ['store_admin', 'super_admin'],
    feature: 'coupons',
    audit: {
      action: 'coupon.deleted',
      resourceType: 'coupon',
      resourceId: a => a.couponId,
      details: (_a, r) => ({ code: r?.code }),
    },
    summarize: async (a, ctx) => {
      const c: any = await ctx.inStore(() => CouponService.getById(ctx.store.id, a.couponId));
      return `Delete coupon ${c.code} (${c.type} ${c.value}). Shoppers can no longer use it.`;
    },
    run: async (a, ctx) => {
      const c: any = await ctx.inStore(() => CouponService.getById(ctx.store.id, a.couponId));
      await ctx.inStore(() => CouponService.delete(ctx.store.id, a.couponId));
      return { couponId: a.couponId, code: c.code, deleted: true };
    },
  },

  // ── Returns / refunds ─────────────────────────────────────────────────────
  {
    // return.routes.ts POST /admin/:id/approve — returns:write + returns
    name: 'admin_approve_return',
    description: 'Approve a customer’s return request. Moves no money.',
    input: { returnId: z.string().min(1), notes: z.string().max(1000).optional() },
    permission: 'returns:write',
    feature: 'returns',
    audit: {
      action: 'return.approved',
      resourceType: 'return',
      resourceId: a => a.returnId,
      details: (_a, r) => ({ returnNumber: r?.returnNumber }),
    },
    run: async (a, ctx) => {
      const r: any = await ctx.inStore(() =>
        ReturnService.approve(ctx.store.id, a.returnId, ctx.auth.userId, a.notes)
      );
      return { returnId: r.id, returnNumber: r.returnNumber, status: r.status };
    },
  },
  {
    // return.routes.ts POST /admin/:id/reject — same guards (reason required)
    name: 'admin_reject_return',
    description:
      'Reject a customer’s return request. A reason is required and is shown to the customer.',
    input: { returnId: z.string().min(1), reason: z.string().min(1).max(1000) },
    permission: 'returns:write',
    feature: 'returns',
    audit: {
      action: 'return.rejected',
      resourceType: 'return',
      resourceId: a => a.returnId,
      details: (a, r) => ({ returnNumber: r?.returnNumber, reason: a.reason }),
    },
    run: async (a, ctx) => {
      const r: any = await ctx.inStore(() =>
        ReturnService.reject(ctx.store.id, a.returnId, ctx.auth.userId, a.reason)
      );
      return { returnId: r.id, returnNumber: r.returnNumber, status: r.status };
    },
  },
  {
    // return.routes.ts POST /admin/:id/received — same guards
    name: 'admin_mark_return_received',
    description: 'Record that the returned goods arrived. Moves no money.',
    input: { returnId: z.string().min(1) },
    permission: 'returns:write',
    feature: 'returns',
    audit: {
      action: 'return.received',
      resourceType: 'return',
      resourceId: a => a.returnId,
      details: (_a, r) => ({ returnNumber: r?.returnNumber }),
    },
    run: async (a, ctx) => {
      const r: any = await ctx.inStore(() =>
        ReturnService.markReceived(ctx.store.id, a.returnId, ctx.auth.userId)
      );
      return { returnId: r.id, returnNumber: r.returnNumber, status: r.status };
    },
  },
  {
    // return.routes.ts POST /admin/:id/complete — returns:write + returns; a
    // GATEWAY method (money back to the shopper's card) additionally needs orders:refund.
    name: 'admin_complete_return',
    description:
      'Complete a return and refund the customer with the chosen refundMethod. DESTRUCTIVE and MOVES ' +
      'MONEY: the first call changes nothing and returns a confirmToken plus what would be refunded ' +
      '(read it to the merchant); call again with the SAME arguments plus the token to refund. ' +
      'Refunding to the original payment method (gateway) or as store_credit needs the orders:refund permission, which ' +
      'staff do not have.',
    input: { returnId: z.string().min(1), refundMethod: z.enum(REFUND_METHODS) },
    destructive: true,
    permission: 'returns:write',
    feature: 'returns',
    extraAuthorize: (a, auth) => {
      // Mirrors return.routes.ts: a gateway method sends money back through the provider, and
      // `store_credit` credits the customer's spendable wallet (F-10, Ruling S8-1, parallel
      // branch fix/security-batch-2026-10-14). Both need orders:refund; staff lack it.
      if (
        (isGatewayRefundMethod(a.refundMethod) || a.refundMethod === 'store_credit') &&
        !hasPermission(auth.role as Role, 'orders:refund')
      ) {
        throw new Error(
          'FORBIDDEN: refunding to the original payment method or as store credit needs the orders:refund permission; the key’s owner lacks it.'
        );
      }
    },
    audit: {
      action: 'return.completed',
      resourceType: 'return',
      resourceId: a => a.returnId,
      details: (a, r) => ({ refundMethod: a.refundMethod, returnNumber: r?.returnNumber }),
    },
    summarize: async (a, ctx) => {
      const preview: any = await ctx.inStore(() =>
        ReturnService.refundPreview(ctx.store.id, a.returnId)
      );
      return (
        `Complete return ${a.returnId} and refund via "${a.refundMethod}". ` +
        `Gateway refund available: ${preview?.gateway?.available ?? 'unknown'}, ` +
        `gateway amount: ${preview?.gateway?.amount ?? 'n/a'}. This may move real money and cannot be undone.`
      );
    },
    run: async (a, ctx) => {
      const r: any = await ctx.inStore(() =>
        ReturnService.complete(ctx.store.id, a.returnId, ctx.auth.userId, a.refundMethod)
      );
      return { returnId: r.id, returnNumber: r.returnNumber, status: r.status };
    },
  },
];

/**
 * Every tool name registered here. `mcp-admin.routes.ts` mounts a write-specific
 * rate limiter that counts only `tools/call` for these names; reads stay on the
 * router-wide limiter.
 */
export const ADMIN_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(WRITE_TOOLS.map(t => t.name));

export function registerAdminWriteTools(server: McpServer, store: McpStore): void {
  for (const spec of WRITE_TOOLS) registerMerchantWriteTool(server, store, spec);
}
