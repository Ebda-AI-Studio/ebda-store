import type { JobDef } from '../../jobs/types';
import { acrossStores, storeDirectory, withStore } from '@ebda/database';
import { alarmStoreId } from '../../jobs/store-scope';
import { runInStoreCtx, storeRwClient } from '../../jobs/store-db';
import { storeRepo } from '../../repo-factory';
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
import {
  buildFanoutEvents,
  SourceNotReadyError,
  type SourceEventName,
} from '../../../services/webhook-events';
import {
  delayBeforeAttempt,
  fanoutWebhookEvent,
  markDeliveryFailed,
  runDeliveryAttempt,
  webhookStoreEntitled,
} from '../../../services/webhook.service';

/**
 * Merchant outgoing webhooks (docs/plans/2026-10-21-merchant-webhooks.md).
 *   webhook-fanout         source event -> one delivery row per subscribed endpoint -> dispatch events
 *   webhook-deliver        up to WEBHOOK_MAX_ATTEMPTS tries with the step.sleep schedule (~24h)
 *   webhook-delivery-purge daily: rows older than WEBHOOK_LOG_RETENTION_DAYS
 * NOT every source event is sent after the producer's COMMIT: `order/created` (COD/wallet) and
 * `order/status-changed` are sent from inside the request transaction (review I1, Ruling WH-8). The
 * fan-out therefore never trusts the event: it re-reads the row, requires it to be in the state the
 * event announces, and otherwise waits (FANOUT_NOT_READY_WAITS_SEC) and retries before dropping.
 */

const SOURCES = [
  'order/created',
  'order/status-changed',
  'order/refunded',
  'product.upserted',
  'product.deleted',
  'webhook/inventory.low',
] as const;

/** Seconds to wait before re-reading a source row that is not visible / not in the announced state yet. */
export const FANOUT_NOT_READY_WAITS_SEC = [2, 10, 30, 120, 300] as const;

type FanoutStep = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  sleep: (id: string, duration: string) => Promise<unknown>;
  sendEvent: (id: string, payload: unknown) => Promise<unknown>;
};

/** The fan-out body, separate from the Inngest wrapper so it is testable with a fake `step`. */
export async function runWebhookFanout(
  step: FanoutStep,
  event: { name: string; id?: string; data: Record<string, unknown> }
): Promise<Record<string, unknown>> {
  const storeId = event.data.storeId as string | undefined;
  if (!storeId) return { skipped: 'no_store' };
  // A store that dropped below Growth no longer sends (I3); its source rows are not even read.
  if (!(await step.run('check-plan', () => webhookStoreEntitled(storeId)))) {
    return { skipped: 'not_entitled' };
  }
  let ids: string[] | null = null;
  for (let i = 0; i <= FANOUT_NOT_READY_WAITS_SEC.length; i++) {
    // Each pass is its own memoised step, so a replay never repeats a completed one.
    const r = await step.run(`create-deliveries-${i}`, () =>
      runInStoreCtx(storeId, async () => {
        const { db } = await storeRwClient(storeId);
        const subscribers = await db.webhookEndpoint.count({
          where: { storeId, active: true },
        });
        if (subscribers === 0) return { ready: true as const, ids: [] as string[] };
        try {
          const events = await buildFanoutEvents(
            storeId,
            event.name as SourceEventName,
            event.data,
            event.id ?? ''
          );
          const created: string[] = [];
          for (const ev of events) created.push(...(await fanoutWebhookEvent(storeId, ev)));
          return { ready: true as const, ids: created };
        } catch (err) {
          if (err instanceof SourceNotReadyError)
            return { ready: false as const, ids: [] as string[] };
          throw err;
        }
      })
    );
    if (r.ready) {
      ids = r.ids;
      break;
    }
    if (i < FANOUT_NOT_READY_WAITS_SEC.length) {
      await step.sleep(`wait-source-${i}`, `${FANOUT_NOT_READY_WAITS_SEC[i]}s`);
    }
  }
  if (ids === null) {
    logger.warn(
      { storeId, event: event.name },
      '[webhooks] source never reached the announced state; dropped'
    );
    return { skipped: 'source_not_ready' };
  }
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

export const webhookFanout: JobDef = inngest.createFunction(
  {
    id: 'webhook-fanout',
    name: 'Merchant webhooks - fan out an event',
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: SOURCES.map(event => ({ event: event as any })),
  },
  async ({ event, step }) =>
    runWebhookFanout(step as unknown as FanoutStep, event as Parameters<typeof runWebhookFanout>[1])
);

async function notifyEndpointDisabled(storeId: string, endpointId: string): Promise<void> {
  const info = await runInStoreCtx(storeId, async () => {
    const { db } = await storeRwClient(storeId);
    const endpoint = await db.webhookEndpoint.findFirst({
      where: { id: endpointId, storeId },
      select: { url: true },
    });
    // `Store` and its owner are platform rows (read from Postgres for either backend)
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, owner: { select: { email: true } } },
      })
    );
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

export const webhookDeliver: JobDef = inngest.createFunction(
  {
    id: 'webhook-deliver',
    // The same delivery request delivered twice must not start two runs that both POST.
    idempotency: 'event.data.deliveryId',
    name: 'Merchant webhooks - deliver with retries',
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: [{ event: 'webhook/delivery.requested' as any }],
    // The run itself failed (not just one attempt): never leave the row pending for ever (M7).
    onFailure: async ({
      event,
    }: {
      event: { data: { event: { data: { storeId: string; deliveryId: string } } } };
    }) => {
      const { storeId, deliveryId } = event.data.event.data;
      await markDeliveryFailed(storeId, deliveryId, 'run_failed');
    },
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

export const webhookDeliveryPurge: JobDef = inngest.createFunction(
  {
    id: 'webhook-delivery-purge-daily',
    name: `Purge webhook deliveries older than ${WEBHOOK_LOG_RETENTION_DAYS} days`,
    retries: 1,
    triggers: [{ cron: '45 4 * * *' }],
  },
  async ({ event, step }) => {
    const purged = await step.run('purge', async () => {
      const cutoff = new Date(Date.now() - WEBHOOK_LOG_RETENTION_DAYS * 86_400_000);
      // A store on its Durable Object purges its own log on its alarm (Ruling CF-JOBS-4B)
      const only = alarmStoreId(event);
      if (only) {
        const repo = await storeRepo(only);
        if (repo.backend === 'do') {
          const r = await repo.writer.webhookDelivery.deleteMany({
            where: { storeId: only, createdAt: { lt: cutoff } },
          });
          return { count: r.count, failed: 0 };
        }
      }
      const storeIds = only
        ? [only]
        : (await storeDirectory(undefined, { includeDeleted: true })).map(s => s.id);
      let failed = 0;
      const results = await acrossStores(
        async storeId =>
          (await storeRwClient(storeId)).db.webhookDelivery.deleteMany({
            where: { storeId, createdAt: { lt: cutoff } },
          }),
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
