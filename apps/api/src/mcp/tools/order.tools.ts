import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prisma, runInTenantContext, withTenantContext } from '@force/database';
import type { McpStore } from '../resolve-store';
import { OrderService } from '../../services/order.service';
import { PaymentService } from '../../services/payment-providers/payment.factory';
import type { Currency } from '../../services/payment-providers/types';
import { recordPaymentEvent } from '../../services/payment-event.service';
import { auditLog } from '../../middleware/security';
import { AppError } from '../../middleware/error-handler';
import { config } from '../../config';
import logger from '../../lib/logger';
import { buildPaymentLineItems } from '../../lib/payment-line-items';
import { ok } from './tool-result';

/**
 * Agent orders reuse the SAME required-field contract as a human guest
 * order (`shippingAddressSchema` in `public.routes.ts`): firstName+lastName
 * (derived from `name`), address1, country. Nothing stricter, nothing
 * looser — `source: 'agent'` is audit-only and must never relax or add to
 * these requirements. `name`/`address` are required so a missing one fails
 * Zod validation, which the MCP SDK converts to `{ isError: true }` (same
 * as a thrown AppError) rather than a protocol-level rejection — confirmed
 * against `validateToolInput`'s catch in
 * `@modelcontextprotocol/sdk/server/mcp.js`.
 */
const customerSchema = z.object({
  name: z.string().trim().min(1),
  phone: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  address: z.string().trim().min(1),
  city: z.string().trim().optional(),
  country: z.string().trim().min(2).default('KW'),
});

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0] };
}

// Mirrors payment.routes.ts's storefront-base-url derivation (POST
// /payments/create, online branch): custom domain wins, else the
// platform web app at /<slug>.
function storefrontBaseUrl(store: McpStore): string {
  return store.domain ? `https://${store.domain}` : `${config.webUrl}/${store.slug}`;
}

export function registerOrderTools(server: McpServer, store: McpStore): void {
  server.registerTool(
    'place_order',
    {
      description:
        'Place a guest order from a cart. paymentMethod "cod" completes immediately (cash on delivery, requires the store to have COD configured). "online" creates the order and returns a paymentUrl a human must open to pay.',
      inputSchema: {
        cartId: z.string().min(1),
        paymentMethod: z.enum(['cod', 'online']),
        customer: customerSchema,
      },
    },
    async ({ cartId, paymentMethod, customer }) => {
      const { firstName, lastName } = splitName(customer.name);
      const shippingAddress = {
        firstName,
        lastName,
        address1: customer.address,
        city: customer.city ?? '',
        state: '',
        postalCode: '',
        country: customer.country,
        phone: customer.phone,
        email: customer.email,
      };

      if (paymentMethod === 'cod') {
        // Mirror POST /payments/create's COD-availability gate EXACTLY
        // (store-specific PaymentConfig row first, then a platform-wide
        // one) — an agent must not be able to place a COD order in a
        // store that never enabled COD. Checked BEFORE creating the
        // order so a store with no COD config never gets an orphan
        // agent order.
        const codConfig = await prisma.paymentConfig.findFirst({
          where: {
            OR: [
              { storeId: store.id, provider: 'cod', isEnabled: true },
              { storeId: null, provider: 'cod', isEnabled: true },
            ],
          },
          orderBy: { storeId: 'desc' },
        });
        if (!codConfig) {
          throw new AppError(
            400,
            'COD_NOT_AVAILABLE',
            'Cash on Delivery is not available for this store'
          );
        }

        // Same required fields as a human guest order — OrderService.create
        // throws (EMPTY_CART / INSUFFICIENT_INVENTORY / etc.) exactly like
        // the storefront checkout path; left to propagate as an isError.
        const order = await OrderService.create(store.id, undefined, cartId, {
          shippingAddress,
          paymentMethod: 'cod',
          source: 'agent',
        });

        // Same COD-fee + Payment-row bookkeeping as POST /payments/create's
        // cod branch, so an agent COD order is indistinguishable from a
        // human COD order to the rest of the platform (admin order detail,
        // "mark cash collected" flow, payment events).
        const codFee = codConfig.fixedFee ? Number(codConfig.fixedFee) : 0;
        const total = codFee > 0 ? order.total + codFee : order.total;

        // Tenant-scoped AND atomic: `withTenantContext` runs both writes
        // inside ONE Prisma interactive transaction with `app.current_store_id`
        // SET LOCAL (same RLS discipline the human `payment.routes.ts` cod
        // branch gets from its request-level `runInTenantContext` wrap). Doing
        // this in a single transaction is a correctness improvement over even
        // the human path: if `payment.create` throws, the `order.update` total
        // bump rolls back with it instead of leaving the order permanently
        // overcharged with no `cod_pending` Payment row to show for it.
        const payment = await withTenantContext(store.id, async tx => {
          if (codFee > 0) {
            await tx.order.update({ where: { id: order.id }, data: { total } });
          }
          return tx.payment.create({
            data: {
              orderId: order.id,
              provider: 'cod',
              method: 'cod',
              status: 'cod_pending',
              amount: total,
              currency: order.currency,
              metadata: { codFee, originalTotal: order.total, source: 'agent' },
            },
          });
        });

        // Non-fatal bookkeeping (unchanged semantics — each still swallows
        // its own error via .catch), now tenant-scoped like the human path.
        await runInTenantContext(store.id, async () => {
          await recordPaymentEvent({
            paymentId: payment.id,
            storeId: store.id,
            orderId: order.id,
            eventType: 'created',
            toStatus: 'cod_pending',
            provider: 'cod',
            details: { amount: total, codFee, originalTotal: order.total, source: 'agent' },
          }).catch(err =>
            logger.error({ err, orderId: order.id }, '[MCP place_order] recordPaymentEvent failed')
          );

          await auditLog({
            action: 'payment.created',
            resourceType: 'payment',
            resourceId: payment.id,
            storeId: store.id,
            details: { orderId: order.id, amount: total, codFee, provider: 'cod', source: 'agent' },
          }).catch(err =>
            logger.error({ err, orderId: order.id }, '[MCP place_order] auditLog failed')
          );
        });

        return ok({
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentMethod: 'cod',
          total,
          currency: order.currency,
        });
      }

      // Online: resolve the default provider EXPLICITLY first (before
      // creating an order) so a store with no online provider configured
      // never gets an orphan unpaid order — the tool errors cleanly
      // instead. `PaymentService.createPayment` would also throw
      // PAYMENT_NOT_CONFIGURED at this point, but only AFTER the order
      // (and its inventory decrement + cart clear) already committed.
      const provider = await PaymentService.getDefaultProvider(store.id);
      if (!provider) {
        throw new AppError(
          400,
          'PAYMENT_NOT_CONFIGURED',
          'No online payment method is configured for this store'
        );
      }

      const order = await OrderService.create(store.id, undefined, cartId, {
        shippingAddress,
        paymentMethod: 'online',
        source: 'agent',
      });

      const base = storefrontBaseUrl(store);
      try {
        // Faithfully replicates POST /payments/create's online-branch
        // request shape (payment.routes.ts): same customer/items mapping,
        // same callback/error URL convention, same
        // `.../webhooks/payment/<provider>` webhook shape — provider is
        // resolved explicitly above rather than left undefined.
        const payment = await PaymentService.createPayment(
          {
            orderId: order.id,
            orderNumber: order.orderNumber,
            amount: order.total,
            currency: order.currency as Currency,
            customer: {
              id: `guest-${order.id}`,
              name: customer.name,
              email: customer.email ?? '',
              phone: customer.phone,
            },
            // Same collapse every other payment-provider call site uses
            // (`payment.routes.ts` /create, `order.routes.ts` payment-link,
            // `payment.factory.ts` retry — see `payment-line-items.ts`'s I3
            // note): a bundle box must reach the gateway's hosted page as
            // ONE line at the bundle price, never its per-component
            // allocated shares. This call site mapped `order.items` raw and
            // was the one instance final review missed.
            items: buildPaymentLineItems(order.items),
            callbackUrl: `${base}/checkout/success`,
            errorUrl: `${base}/checkout/error`,
            webhookUrl: `${config.apiUrl}/api/v1/webhooks/payment/${provider}`,
          },
          provider,
          store.id
        );

        return ok({
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentMethod: 'online',
          total: order.total,
          currency: order.currency,
          paymentUrl: payment.paymentUrl,
        });
      } catch (err) {
        // Compensating rollback — same pattern as POST /payments/create's
        // catch block: the order committed (cart cleared, inventory
        // decremented) but the payment step failed, so undo it rather than
        // strand an unpaid, cart-less order the agent/customer can't retry.
        await OrderService.rollbackForPaymentFailure(store.id, order.id, cartId).catch(rbErr =>
          logger.error(
            { err: rbErr, orderId: order.id, storeId: store.id },
            '[MCP place_order] order rollback failed after payment-create failure'
          )
        );
        throw err;
      }
    }
  );

  server.registerTool(
    'get_order_status',
    {
      description: 'Read the current status of an order placed through this store.',
      inputSchema: { orderId: z.string().min(1) },
    },
    async ({ orderId }) => {
      // OrderService.getById throws AppError(404, 'NOT_FOUND', ...) for an
      // unknown/other-store order — propagated as isError, same as
      // catalog.tools.ts's get_product.
      const o = await OrderService.getById(store.id, orderId);

      // Explicit allow-list — NO customer/email/shippingAddress/items. Even
      // though `getById`'s include pulls customer + shipping/billing
      // address + line items (needed for the admin order-detail view),
      // returning any of that here would leak PII to whatever agent/LLM is
      // calling this tool on the customer's behalf.
      return ok({
        orderId: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        paymentStatus: o.paymentStatus,
        total: o.total,
        currency: o.currency,
        source: o.source ?? 'web',
      });
    }
  );
}
