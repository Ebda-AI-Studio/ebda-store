/**
 * Order WhatsApp Notify — Force Store ↔ WBS Bridge
 *
 * Fires on order lifecycle events and sends a WhatsApp template message to the
 * customer through the merchant's Force WhatsApp Business Platform client.
 *
 * Covered events:
 *   order/created  → orderPaid template
 *   order/shipped  → orderShipped template
 *   order/delivered → orderDelivered template
 *
 * Skip conditions (all INFO-logged, never error — never block the order):
 *   - store.wbsEnabled = false
 *   - no wbsClientId / wbsApiKey / wbsTemplates config
 *   - template name not configured for this event
 *   - customer has no phone number, or phone is not valid E.164
 *
 * Error strategy:
 *   - WbsUnauthorizedError (401) → log error + Sentry + increment failure counter
 *     → auto-disable store (wbsEnabled = false) after 3 consecutive 401s
 *   - WbsTemplateMissingError (422) → log error, do NOT retry (Inngest won't see a throw)
 *   - WbsServerError / network errors → rethrow so Inngest retries (retries: 2)
 */

import type { InngestFunction } from 'inngest';
import * as Sentry from '@sentry/node';
import { prisma } from '@force/database';
import { inngest } from '../client';
import {
  wbsBridgeService,
  WbsUnauthorizedError,
  WbsTemplateMissingError,
} from '../../../services/wbs-bridge.service';
import { featureService } from '../../../services/feature.service';
import { validateE164 } from '../../../utils/phone-e164';
import logger from '../../logger';

// ─── Types ──────────────────────────────────────────────────────────────────

type EventName = 'order/created' | 'order/shipped' | 'order/delivered';

type TemplateKey = 'orderPaid' | 'orderShipped' | 'orderDelivered';

interface TemplateChannels {
  whatsapp?: boolean;
  email?: boolean;
}

interface TemplateConfig {
  name: string;
  languageCode: string;
  /** Per-event channel toggles. Absent = both on (backward-compatible). */
  channels?: TemplateChannels;
}

interface WbsTemplates {
  orderPaid?: TemplateConfig;
  orderShipped?: TemplateConfig;
  orderDelivered?: TemplateConfig;
}

const EVENT_TO_TEMPLATE_KEY: Record<EventName, TemplateKey> = {
  'order/created': 'orderPaid',
  'order/shipped': 'orderShipped',
  'order/delivered': 'orderDelivered',
};

// Consecutive 401 threshold before we auto-disable the integration
const AUTO_DISABLE_THRESHOLD = 3;

// ─── Inner handler (exported for unit testing) ──────────────────────────────

interface StepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/** Pure business logic — called by the Inngest wrapper and directly by unit tests. */
export async function handleOrderWhatsAppNotify(
  eventName: EventName,
  orderId: string,
  storeId: string,
  step: StepRunner
): Promise<Record<string, unknown>> {
  // Guard against Inngest sync-UI test payloads (data: {})
  if (!orderId || !storeId) {
    logger.warn({ eventName }, '[WBS-NOTIFY] fired without ids — skipping');
    return { skipped: 'missing-ids' };
  }

  // ── Step 0: Platform feature gate ──────────────────────────────────────
  // Super-admin entitlement check: is this merchant on a plan that includes
  // WhatsApp notifications? Independent of the merchant's per-store wbsEnabled
  // toggle — both must be on for sends to fire.
  const featureEnabled = await step.run('check-feature-flag', () =>
    featureService.isFeatureEnabled(storeId, 'whatsapp')
  );
  if (!featureEnabled) {
    logger.info({ storeId }, '[WBS-NOTIFY] WhatsApp feature not enabled for store — skipping');
    return { skipped: 'feature-disabled' };
  }

  // ── Step 1: Load store config ──────────────────────────────────────────
  const storeConfig = await step.run('load-store-config', async () => {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        name: true,
        wbsEnabled: true,
        wbsClientId: true,
        wbsApiKey: true,
        wbsTemplates: true,
      },
    });
  });

  if (!storeConfig) {
    logger.warn({ storeId }, '[WBS-NOTIFY] Store not found — skipping');
    return { skipped: 'store-not-found' };
  }

  if (!storeConfig.wbsEnabled) {
    logger.info({ storeId }, '[WBS-NOTIFY] WBS not enabled for store — skipping');
    return { skipped: 'wbs-disabled' };
  }

  if (!storeConfig.wbsClientId || !storeConfig.wbsApiKey) {
    logger.info({ storeId }, '[WBS-NOTIFY] WBS not fully configured — skipping');
    return { skipped: 'wbs-not-configured' };
  }

  // ── Step 2: Resolve template config for this event ────────────────────
  const templateKey = EVENT_TO_TEMPLATE_KEY[eventName];
  const templates = storeConfig.wbsTemplates as WbsTemplates | null;
  const templateConfig: TemplateConfig | undefined = templates?.[templateKey];

  if (!templateConfig?.name) {
    logger.info(
      { storeId, eventName, templateKey },
      '[WBS-NOTIFY] No template configured for this event — skipping'
    );
    return { skipped: 'template-not-configured' };
  }

  // Merchant-level channel toggle: check channels.whatsapp.
  // When explicitly set to false, skip the WhatsApp send for this event.
  // Absent channels object = WhatsApp on (backward-compatible default).
  if (templateConfig.channels?.whatsapp === false) {
    logger.info(
      { storeId, eventName, templateKey },
      '[WBS-NOTIFY] WhatsApp channel disabled by merchant for this event — skipping'
    );
    return { skipped: 'whatsapp-channel-disabled' };
  }

  // ── Step 3: Load order + customer phone ───────────────────────────────
  const order = await step.run('load-order', async () => {
    return prisma.order.findUnique({
      where: { id: orderId },
      select: {
        orderNumber: true,
        total: true,
        currency: true,
        shippingAddress: true,
        shipment: { select: { trackingNumber: true } },
        customer: {
          select: {
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
          },
        },
      },
    });
  });

  if (!order) {
    logger.warn({ orderId }, '[WBS-NOTIFY] Order not found — skipping');
    return { skipped: 'order-not-found' };
  }

  // Resolve customer name (registered or guest)
  const shippingAddr = order.shippingAddress as Record<string, unknown> | null;
  const customerName =
    `${order.customer?.firstName || shippingAddr?.firstName || ''} ${order.customer?.lastName || shippingAddr?.lastName || ''}`.trim() ||
    order.customer?.email ||
    'Customer';

  // Resolve phone: registered customer first, then shipping address
  const rawPhone =
    order.customer?.phone || (typeof shippingAddr?.phone === 'string' ? shippingAddr.phone : null);

  const recipientPhone = validateE164(rawPhone);
  if (!recipientPhone) {
    logger.info(
      { storeId, orderId },
      '[WBS-NOTIFY] Customer phone missing or not E.164 — skipping silently'
    );
    return { skipped: 'invalid-phone' };
  }

  // ── Step 4: Build variables ────────────────────────────────────────────
  // Standard positional variables for all order templates.
  // Template must have {{1}} through {{N}} body placeholders in this order.
  const orderTotal = (order.total / 100).toFixed(3); // pence → currency units
  const trackingNumber = order.shipment?.trackingNumber ?? '';

  // Base variables — all templates get these
  const variables: string[] = [
    customerName,
    order.orderNumber,
    `${orderTotal} ${order.currency}`,
    storeConfig.name,
  ];

  // Append trackingNumber only for shipped / delivered (non-empty guard)
  if ((eventName === 'order/shipped' || eventName === 'order/delivered') && trackingNumber) {
    variables.push(trackingNumber);
  }

  // ── Step 5: Send via WBS bridge ────────────────────────────────────────
  const idempotencyKey = `${orderId}-${eventName}-${storeConfig.wbsClientId}`;

  const result = await step.run('send-whatsapp', async () => {
    try {
      return await wbsBridgeService.sendOrderNotification({
        encryptedApiKey: storeConfig.wbsApiKey!,
        recipientPhone,
        templateName: templateConfig.name,
        languageCode: templateConfig.languageCode || 'en',
        variables,
        idempotencyKey,
        // Phase 6 final-loop: pass the order id so WBS can stamp
        // wa_carts.fwb_order_id when auto-completing the cart on this send.
        fwbOrderId: orderId,
      });
    } catch (err) {
      if (err instanceof WbsUnauthorizedError) {
        // 401 — bad API key. Alert and potentially auto-disable.
        logger.error({ storeId, err: err.message }, '[WBS-NOTIFY] WBS rejected API key');

        try {
          Sentry.captureException(err, {
            extra: { storeId, event: eventName, wbsClientId: storeConfig.wbsClientId },
          });
        } catch {
          // Sentry not configured — swallow
        }

        // Auto-disable after consecutive failures: check how many 401 logs
        // are recorded in NotificationLog for this store in the last 24 hours.
        const recentFailures = await prisma.notificationLog.count({
          where: {
            storeId,
            channel: 'wbs_bridge',
            status: 'failed',
            error: 'WBS_UNAUTHORIZED',
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        });

        if (recentFailures >= AUTO_DISABLE_THRESHOLD - 1) {
          await prisma.store.update({
            where: { id: storeId },
            data: { wbsEnabled: false },
          });
          logger.error(
            { storeId, recentFailures },
            '[WBS-NOTIFY] Auto-disabled WBS integration after repeated 401s'
          );
        }

        // Record the failure
        await prisma.notificationLog
          .create({
            data: {
              storeId,
              channel: 'wbs_bridge',
              event: eventName,
              status: 'failed',
              error: 'WBS_UNAUTHORIZED',
              idempotencyKey,
              metadata: { templateName: templateConfig.name },
            },
          })
          .catch(() => {});

        // Do NOT rethrow — 401 is not retryable
        return { skipped: 'wbs-unauthorized' };
      }

      if (err instanceof WbsTemplateMissingError) {
        logger.error(
          { storeId, err: err.message, templateName: templateConfig.name },
          '[WBS-NOTIFY] Template not approved in Meta'
        );

        try {
          Sentry.captureException(err, {
            extra: { storeId, event: eventName, templateName: templateConfig.name },
          });
        } catch {
          // swallow
        }

        await prisma.notificationLog
          .create({
            data: {
              storeId,
              channel: 'wbs_bridge',
              event: eventName,
              status: 'failed',
              error: 'WBS_TEMPLATE_MISSING',
              idempotencyKey,
              metadata: { templateName: templateConfig.name },
            },
          })
          .catch(() => {});

        // Do NOT rethrow — 422 is not retryable
        return { skipped: 'template-not-approved' };
      }

      // 5xx / network error — rethrow so Inngest retries
      throw err;
    }
  });

  // If the result has a skipped field it came from a non-retryable path inside step.run
  if (result && typeof result === 'object' && 'skipped' in result) {
    return result as Record<string, unknown>;
  }

  // Record success in NotificationLog
  await step.run('record-success', async () => {
    await prisma.notificationLog
      .create({
        data: {
          storeId,
          channel: 'wbs_bridge',
          event: eventName,
          status: 'sent',
          providerMessageId: (result as { messageId?: string })?.messageId,
          idempotencyKey,
          metadata: {
            templateName: templateConfig.name,
            wbsClientId: storeConfig.wbsClientId,
          },
        },
      })
      .catch(err => logger.error({ err }, '[WBS-NOTIFY] Failed to write NotificationLog'));
  });

  return { sent: true, messageId: (result as { messageId?: string })?.messageId };
}

// ─── Inngest wrapper ─────────────────────────────────────────────────────────

export const orderWhatsAppNotify: InngestFunction.Any = inngest.createFunction(
  {
    id: 'order-whatsapp-notify',
    name: 'Order WhatsApp notify — WBS bridge',
    // retries: 2 per memory rule feedback-bulk-ai-transient-retry:
    // WBS 5xx is transient; Inngest handles exponential backoff automatically.
    retries: 2,
    triggers: [
      { event: 'order/created' },
      { event: 'order/shipped' },
      { event: 'order/delivered' },
    ],
    // Cap concurrency per store — same pattern as order-created fanout
    concurrency: { key: 'event.data.storeId', limit: 5 },
  },
  async ({ event, step }) => {
    const eventName = event.name as EventName;
    const { orderId, storeId } = event.data as { orderId: string; storeId: string };
    return handleOrderWhatsAppNotify(eventName, orderId, storeId, step);
  }
);
