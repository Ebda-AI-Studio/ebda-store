import { z } from 'zod/v3';
import { storeDb } from '../../lib/repo-factory';
import { storefrontOrigin } from '@ebda/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withTenantContext } from '@ebda/database';
import { runInStoreTenantContext } from '../../lib/store-scoped-read';
import type { McpStore } from '../resolve-store';
import { CartService } from '../../services/cart.service';
import { OrderService } from '../../services/order.service';
import { PaymentService } from '../../services/payment-providers/payment.factory';
import type { Currency } from '../../services/payment-providers/types';
import { recordPaymentEvent } from '../../services/payment-event.service';
import { auditLog } from '../../middleware/security';
import { AppError } from '../../middleware/error-handler';
import logger from '../../lib/logger';
import { buildPaymentLineItems } from '../../lib/payment-line-items';
import {
  alertOrphanedProviderInvoice,
  type OrphanedProviderInvoice,
} from '../../services/payment-providers/orphaned-invoice-alert';
import {
  agentContextFrom,
  assertAgentWrite,
  auditAgentWrite,
  MCP_ID_MAX_CHARS,
} from '../agent-auth';
import { ok } from './tool-result';

import { paymentWebhookUrl } from '../../services/payment-providers/webhook-url';
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
  country: z.string().trim().min(2).default('EG'),
});

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0] };
}

// Mirrors payment.routes.ts's storefront-base-url derivation (POST
// /payments/create, online branch): custom domain wins, else the
// store's free `<slug>.ebda.app` origin.
function storefrontBaseUrl(store: McpStore): string {
  return storefrontOrigin(store);
}

export function registerOrderTools(server: McpServer, store: McpStore): void {
  server.registerTool(
    'place_order',
    {
      description:
        'Place a guest order from a cart. paymentMethod "cod" completes immediately (cash on delivery, requires the store to have COD configured). "online" creates the order and returns a paymentUrl a human must open to pay. WRITE TOOL: requires the store\'s agent credential in the `x-agent-key` header.',
      inputSchema: {
        // Bounded for the same reason as `add_to_cart`'s ids: the denied-write
        // audit below persists `cartId` verbatim and runs BEFORE the credential
        // check. See `MCP_ID_MAX_CHARS`.
        cartId: z.string().min(1).max(MCP_ID_MAX_CHARS),
        paymentMethod: z.enum(['cod', 'online']),
        customer: customerSchema,
        // Gold-rate pricing (Ruling B5-17): a gold piece is priced from today's rate. When the rate moved
        // after the line was added the order is refused with PRICE_CHANGED and `view_cart` shows the old and
        // new price; pass `true` to accept the new price and place the order. The new price always comes
        // from the server, never from this argument.
        acknowledgePrices: z.boolean().optional(),
      },
    },
    async ({ cartId, paymentMethod, customer, acknowledgePrices }, extra) => {
      // WRITE GATE — the money-and-inventory path. Enforced HERE, inside the
      // tool handler, and not as Express middleware: all seven tools ride one
      // POST, so a rejecting `router.use` would 401 the `initialize` handshake
      // and every read tool too and take the whole surface dark. Throwing here
      // is converted by the SDK into `{ isError: true }` carrying an
      // actionable message.
      let context;
      try {
        context = assertAgentWrite('place_order', extra);
      } catch (err) {
        await auditAgentWrite({
          store,
          tool: 'place_order',
          outcome: 'denied',
          context: agentContextFrom(extra),
          details: { cartId, paymentMethod },
        });
        throw err;
      }

      try {
        if (acknowledgePrices === true)
          await runInStoreTenantContext(store.id, () =>
            CartService.acknowledgePrices(store.id, cartId)
          );
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
          const codConfig = await (
            await storeDb(store.id)
          ).paymentConfig.findFirst({
            // The platform-wide (storeId null) row is invisible under the store's
            // RLS and cannot be named under the tenant guard, so only the store's
            // own row is looked up.
            where: { storeId: store.id, provider: 'cod', isEnabled: true },
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
          //
          // Tenant-scoped (issue 2059's class): inside `runInTenantContext`
          // the `withMoneyTx` in `OrderService.create` opens with the store's
          // GUCs, where outside it ran with none. The order id is captured
          // INSIDE the wrap so that if the wrap's own commit fails after the
          // (separately committed) order exists, it is still rolled back
          // rather than stranded.
          let createdOrderId = null as string | null;
          let order: Awaited<ReturnType<typeof OrderService.create>>;
          try {
            order = await runInStoreTenantContext(store.id, async () => {
              const created = await OrderService.create(store.id, undefined, cartId, {
                shippingAddress,
                paymentMethod: 'cod',
                source: 'agent',
              });
              createdOrderId = created.id;
              return created;
            });
          } catch (err) {
            if (createdOrderId) {
              const orderId = createdOrderId;
              await runInStoreTenantContext(store.id, () =>
                OrderService.rollbackForPaymentFailure(store.id, orderId, cartId)
              ).catch(rbErr =>
                logger.error(
                  { err: rbErr, orderId, storeId: store.id },
                  '[MCP place_order] order rollback failed after order-create wrap failure'
                )
              );
            }
            throw err;
          }

          // Same COD-fee + Payment-row bookkeeping as POST /payments/create's
          // cod branch, so an agent COD order is indistinguishable from a
          // human COD order to the rest of the platform (admin order detail,
          // "mark cash collected" flow, payment events).
          // The fee (fixed + percentage) was frozen into `order.total` by
          // OrderService.create (paymentMethod 'cod', ruling MONEYB-3) — the
          // same figure a human shopper is quoted. Nothing is added here.
          const codFee = order.codFee;
          const total = order.total;

          // Tenant-scoped AND atomic: `withTenantContext` runs both writes
          // inside ONE Prisma interactive transaction with `app.current_store_id`
          // SET LOCAL (same RLS discipline the human `payment.routes.ts` cod
          // branch gets from its request-level `runInTenantContext` wrap). Doing
          // this in a single transaction is a correctness improvement over even
          // the human path: if `payment.create` throws, the `order.update` total
          // bump rolls back with it instead of leaving the order permanently
          // overcharged with no `cod_pending` Payment row to show for it.
          //
          // But the ORDER above already committed (inventory decremented, cart
          // cleared), so a failure here must undo it — the same compensating
          // rollback the online branch below and the human path
          // (payment.routes.ts) run. Otherwise the agent is left with an
          // orphan order it cannot retry: its cart is gone (EMPTY_CART). #956
          let payment;
          try {
            payment = await withTenantContext(store.id, async tx => {
              return tx.payment.create({
                data: {
                  orderId: order.id,
                  provider: 'cod',
                  method: 'cod',
                  status: 'cod_pending',
                  amount: total,
                  currency: order.currency,
                  metadata: { codFee, originalTotal: order.total - codFee, source: 'agent' },
                },
              });
            });
          } catch (err) {
            // Its own fresh tenant wrap, like the two sibling rollbacks: the
            // payment transaction above has rolled back, so there is no
            // ambient scope and, under ebda_app, the rollback's reads would
            // see no rows and silently do nothing (PR 2301 audit).
            await runInStoreTenantContext(store.id, () =>
              OrderService.rollbackForPaymentFailure(store.id, order.id, cartId)
            ).catch(rbErr =>
              logger.error(
                { err: rbErr, orderId: order.id, storeId: store.id },
                '[MCP place_order] order rollback failed after COD payment-create failure'
              )
            );
            throw err;
          }
          const codPayment = payment;

          // Non-fatal bookkeeping (each call swallows its own error via
          // .catch), tenant-scoped like the human path. The order AND its
          // cod_pending Payment are committed by now, so nothing past this
          // point may surface as a failed checkout: the transaction envelope
          // itself can reject before the callback runs (P2024 pool wait,
          // P2028), and letting that reach the outer catch would audit a real,
          // shippable order as `agent.write.failed` and tell the agent its
          // checkout failed — while its retry hits EMPTY_CART. #1648
          await runInStoreTenantContext(store.id, async () => {
            await recordPaymentEvent({
              paymentId: codPayment.id,
              storeId: store.id,
              orderId: order.id,
              eventType: 'created',
              toStatus: 'cod_pending',
              provider: 'cod',
              details: {
                amount: total,
                codFee,
                originalTotal: order.total - codFee,
                source: 'agent',
              },
            }).catch(err =>
              logger.error(
                { err, orderId: order.id },
                '[MCP place_order] recordPaymentEvent failed'
              )
            );

            // Attribution: this row used to carry no `ip`, no `userAgent` and no
            // agent identity at all, so a completed agent order was
            // indistinguishable in `audit_logs` from a row with no origin. All
            // three are real columns on `audit_logs` — `auditLog` just was not
            // being given them.
            await auditLog({
              action: 'payment.created',
              resourceType: 'payment',
              resourceId: codPayment.id,
              storeId: store.id,
              ip: context.ip,
              userAgent: context.userAgent,
              details: {
                orderId: order.id,
                amount: total,
                codFee,
                provider: 'cod',
                source: 'agent',
                agentClientId: context.grant === 'credential' ? 'credentialed' : context.grant,
                credential: context.credential,
                requestId: context.requestId,
              },
            }).catch(err =>
              logger.error({ err, orderId: order.id }, '[MCP place_order] auditLog failed')
            );
          }).catch(err =>
            logger.error(
              { err, orderId: order.id },
              '[MCP place_order] post-commit bookkeeping failed'
            )
          );

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

        // #900 + issues 2058/2059: tenant-scoped like the human path
        // (payment.routes.ts), in the human path's SHAPE.
        //
        // Order-create runs in its own `runInTenantContext`, so the
        // `withMoneyTx` inside `OrderService.create` opens with the store's
        // GUCs (`$transaction` carries them — `transactionWithGucs`,
        // packages/database). The provider call + Payment write run in a
        // SECOND, separate wrap, so that transaction spans only what the human
        // path's does. The compensating rollback lives OUTSIDE both wraps, in
        // a catch around them: a rollback inside the callback never ran when
        // the wrap's own COMMIT failed (or hit its 30s timeout) AFTER the
        // callback returned — stranding a pending order with stock taken, cart
        // cleared, no Payment row and a live gateway invoice. `rollbackOrderId`
        // is owned from the moment the order exists and cleared only once the
        // payment wrap has COMMITTED (the `rollbackContext = null` of
        // payment.routes.ts). The order is captured INSIDE the create wrap, so
        // a commit failure of that wrap after `OrderService.create` resolved
        // still rolls the (separately committed) order back.
        let rollbackOrderId = null as string | null;
        // Set once the gateway accepts; cleared with the rollback on COMMIT.
        // Still set in the catch = a live invoice with no Payment row
        // (issue 2360, ruling PAY-ORPH-1).
        let acceptedInvoice = null as OrphanedProviderInvoice | null;
        try {
          const order = await runInStoreTenantContext(store.id, async () => {
            const created = await OrderService.create(store.id, undefined, cartId, {
              shippingAddress,
              paymentMethod: 'online',
              source: 'agent',
            });
            rollbackOrderId = created.id;
            return created;
          });

          const base = storefrontBaseUrl(store);
          // Faithfully replicates POST /payments/create's online-branch
          // request shape (payment.routes.ts): same customer/items mapping,
          // same callback/error URL convention, same
          // `.../webhooks/payment/<provider>` webhook shape — provider is
          // resolved explicitly above rather than left undefined.
          //
          // THE PROVIDER CALL HAS NO TRANSACTION OPEN (SP6b): the order above is already
          // committed, the gateway is asked with nothing held (behind its deadline and the
          // per-store breaker), and only the Payment row + its audit event are written in a
          // short transaction of their own.
          const paymentRequest = {
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
            webhookUrl: paymentWebhookUrl(provider, store.id),
          };
          const { providerName: acceptedBy, response: payment } =
            await PaymentService.requestProviderPayment(paymentRequest, provider, store.id);
          acceptedInvoice = {
            storeId: store.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            provider: payment.provider,
            transactionId: payment.transactionId,
            amount: order.total,
            currency: order.currency,
            source: 'agent',
          };
          await runInStoreTenantContext(store.id, () =>
            PaymentService.recordProviderPayment(acceptedBy, paymentRequest, payment, store.id)
          );
          // The Payment row is committed: the order is paid-for-pending now,
          // and must never be rolled back from here on.
          rollbackOrderId = null;
          acceptedInvoice = null;

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
          if (rollbackOrderId) {
            // Compensating rollback — same pattern as POST /payments/create's
            // outer catch: the order committed (cart cleared, inventory
            // decremented) but the payment step failed, so undo it rather than
            // strand an unpaid, cart-less order the agent/customer can't
            // retry. Its own fresh tenant wrap — never the one that failed.
            const orderId = rollbackOrderId;
            await runInStoreTenantContext(store.id, () =>
              OrderService.rollbackForPaymentFailure(store.id, orderId, cartId)
            ).catch(rbErr =>
              logger.error(
                { err: rbErr, orderId, storeId: store.id },
                '[MCP place_order] order rollback failed after payment-create failure'
              )
            );
          }
          if (acceptedInvoice) await alertOrphanedProviderInvoice(acceptedInvoice);
          throw err;
        }
      } catch (err) {
        // A REJECTED checkout is the signal we most want and the one nothing
        // recorded before: an agent order that failed COD availability, ran out
        // of stock, or blew up at the gateway left no row in any table and no
        // distinguishable log line.
        await auditAgentWrite({
          store,
          tool: 'place_order',
          outcome: 'failed',
          context,
          details: { cartId, paymentMethod, error: (err as Error).message },
        });
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
