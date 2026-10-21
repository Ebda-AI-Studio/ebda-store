import type { InngestFunction } from 'inngest';
import { acrossStores, prisma, runInTenantContext, storeDirectory } from '@ebda/database';
import {
  WEBHOOK_CONSECUTIVE_FAILURE_LIMIT,
  WEBHOOK_LOG_RETENTION_DAYS,
  WEBHOOK_MAX_ATTEMPTS,
} from '@ebda/shared';
import { config } from '../../../config';
import logger from '../../logger';
import { inngest } from '../client';
import { EmailService } from '../../../services/email.service';
import { socketService } from '../../../services/socket.service';
import { buildFanoutEvents, type SourceEventName } from '../../../services/webhook-events';
import {
  delayBeforeAttempt,
  fanoutWebhookEvent,
  runDeliveryAttempt,
} from '../../../services/webhook.service';

/**
 * Merchant outgoing webhooks (docs/plans/2026-10-21-merchant-webhooks.md).
 *   webhook-fanout         source event -> one delivery row per subscribed endpoint -> dispatch events
 *   webhook-deliver        up to WEBHOOK_MAX_ATTEMPTS tries with the step.sleep schedule (~24h)
 *   webhook-delivery-purge daily: rows older than WEBHOOK_LOG_RETENTION_DAYS
 * The source events are already sent AFTER the producer's transaction committed
 * (sendEventAfterCommit / deferAfterTenantCommit), so a consumer here never reads uncommitted rows.
 */

const SOURCES = [
  'order/created',
  'order/status-changed',
  'order/refunded',
  'product.upserted',
  'product.deleted',
  'webhook/inventory.low',
] as const;

export const webhookFanout: InngestFunction.Any = inngest.createFunction(
  {
    id: 'webhook-fanout',
    name: 'Merchant webhooks - fan out an event',
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: SOURCES.map(event => ({ event: event as any })),
  },
  async ({ event, step }) => {
    const storeId = (event.data as { storeId?: string }).storeId;
    if (!storeId) return { skipped: 'no_store' };
    const ids = await step.run('create-deliveries', () =>
      runInTenantContext(storeId, async () => {
        const subscribers = await prisma.webhookEndpoint.count({
          where: { storeId, active: true },
        });
        if (subscribers === 0) return [] as string[];
        const events = await buildFanoutEvents(
          storeId,
          event.name as SourceEventName,
          event.data as Record<string, unknown>,
          event.id ?? ''
        );
        const created: string[] = [];
        for (const ev of events) created.push(...(await fanoutWebhookEvent(storeId, ev)));
        return created;
      })
    );
    if (ids.length > 0) {
      await step.sendEvent(
        'dispatch',
        ids.map((deliveryId: string) => ({
          name: 'webhook/delivery.requested',
          data: { storeId, deliveryId },
        }))
      );
    }
    return { deliveries: ids.length };
  }
);

async function notifyEndpointDisabled(storeId: string, endpointId: string): Promise<void> {
  const info = await runInTenantContext(storeId, async () => {
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, storeId },
      select: { url: true },
    });
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, owner: { select: { email: true } } },
    });
    return {
      url: endpoint?.url ?? '',
      name: store?.name ?? storeId,
      to: store?.owner?.email ?? null,
    };
  });
  const webhooksUrl = `${config.adminUrl}/stores/${storeId}/webhooks`;
  socketService.notifyStore(storeId, {
    type: 'webhook_disabled',
    title: 'Webhook turned off',
    message: `Deliveries to ${info.url} failed repeatedly, so the endpoint was turned off.`,
    data: { endpointId, url: webhooksUrl },
    createdAt: new Date(),
  });
  if (info.to) {
    await EmailService.sendWebhookDisabledNotice(storeId, {
      to: info.to,
      storeName: info.name,
      endpointUrl: info.url,
      failures: WEBHOOK_CONSECUTIVE_FAILURE_LIMIT,
      webhooksUrl,
    });
  } else {
    logger.warn({ storeId, endpointId }, '[webhooks] endpoint disabled but the owner has no email');
  }
}

export const webhookDeliver: InngestFunction.Any = inngest.createFunction(
  {
    id: 'webhook-deliver',
    name: 'Merchant webhooks - deliver with retries',
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: [{ event: 'webhook/delivery.requested' as any }],
  },
  async ({ event, step }) => {
    const { storeId, deliveryId } = event.data as { storeId: string; deliveryId: string };
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      const wait = delayBeforeAttempt(attempt);
      if (wait > 0) await step.sleep(`wait-${attempt}`, `${wait}s`);
      const out = await step.run(`attempt-${attempt}`, () =>
        runDeliveryAttempt(storeId, deliveryId, attempt)
      );
      if (out.decision === 'retry') continue;
      if (out.endpointDisabled && out.endpointId) {
        const endpointId = out.endpointId;
        await step.run('notify-endpoint-disabled', () =>
          notifyEndpointDisabled(storeId, endpointId)
        );
      }
      return out;
    }
    return { decision: 'failed' };
  }
);

export const webhookDeliveryPurge: InngestFunction.Any = inngest.createFunction(
  {
    id: 'webhook-delivery-purge-daily',
    name: `Purge webhook deliveries older than ${WEBHOOK_LOG_RETENTION_DAYS} days`,
    retries: 1,
    triggers: [{ cron: '45 4 * * *' }],
  },
  async ({ step }) => {
    const purged = await step.run('purge', async () => {
      const cutoff = new Date(Date.now() - WEBHOOK_LOG_RETENTION_DAYS * 86_400_000);
      const storeIds = (await storeDirectory(undefined, { includeDeleted: true })).map(s => s.id);
      let failed = 0;
      const results = await acrossStores(
        storeId =>
          prisma.webhookDelivery.deleteMany({ where: { storeId, createdAt: { lt: cutoff } } }),
        {
          storeIds,
          onStoreError: (storeId, err) => {
            failed += 1;
            logger.error({ storeId, err }, '[webhooks] purge failed for store');
          },
        }
      );
      return { count: results.reduce((n, r) => n + r.value.count, 0), failed };
    });
    if (purged.failed > 0)
      throw new Error(`webhook-delivery-purge: ${purged.failed} store(s) failed`);
    return purged;
  }
);
