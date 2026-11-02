/**
 * Merchant outgoing webhooks: fan-out, one delivery attempt, and endpoint health.
 * Plan: docs/plans/2026-10-21-merchant-webhooks.md. Every function runs in the AMBIENT tenant
 * (`runInTenantContext` / a request) and carries `storeId` at the top level of every where/data.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@ebda/database';
import {
  WEBHOOK_CONSECUTIVE_FAILURE_LIMIT,
  WEBHOOK_LOG_KEEP_PER_ENDPOINT,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PAYLOAD_VERSION,
  WEBHOOK_RETRY_DELAYS_SEC,
  WEBHOOK_SECRET_PREFIX,
  planIncludesWebhooks,
  WEBHOOK_TEST_EVENT,
  type WebhookEnvelope,
  type WebhookEventType,
} from '@ebda/shared';
import { encryption } from './encryption.service';
import { postWebhook } from '../lib/webhook-http';
import { withSavepoint } from '../lib/savepoint';
import { runInStoreCtx, storeRwClient, type StoreTx } from '../lib/jobs/store-db';
import { getEntitlements } from './plan-entitlements';
import type { FanoutEvent } from './webhook-payload';

// ---------------------------------------------------------------------------
// Pure decisions (unit-tested without a database)
// ---------------------------------------------------------------------------

/** Seconds to wait BEFORE attempt `n` (1-based). 0 for the first. */
export function delayBeforeAttempt(attempt: number): number {
  return WEBHOOK_RETRY_DELAYS_SEC[Math.min(Math.max(attempt, 1), WEBHOOK_MAX_ATTEMPTS) - 1];
}

export type AttemptDecision = 'success' | 'retry' | 'failed';
/** A test event gets exactly one try; everything else gets WEBHOOK_MAX_ATTEMPTS. */
export function decideAfterAttempt(a: {
  ok: boolean;
  attempt: number;
  isTest: boolean;
}): AttemptDecision {
  if (a.ok) return 'success';
  return a.isTest || a.attempt >= WEBHOOK_MAX_ATTEMPTS ? 'failed' : 'retry';
}

export function shouldDisableEndpoint(consecutiveFailures: number): boolean {
  return consecutiveFailures >= WEBHOOK_CONSECUTIVE_FAILURE_LIMIT;
}

export function newWebhookSecret(): { secret: string; hint: string } {
  const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString('hex')}`;
  return { secret, hint: secret.slice(-4) };
}

/** Same logical event, same id: on every endpoint, every re-fan-out, every plumbing re-send. */
export function stableEventId(storeId: string, dedupeKey: string): string {
  return `evt_${createHash('sha256').update(`${storeId}:${dedupeKey}`).digest('hex').slice(0, 32)}`;
}

export function buildEnvelope(a: {
  eventId: string;
  type: WebhookEventType | typeof WEBHOOK_TEST_EVENT;
  storeId: string;
  data: Record<string, unknown>;
  now?: Date;
}): WebhookEnvelope<Record<string, unknown>> {
  return {
    id: a.eventId,
    type: a.type,
    apiVersion: WEBHOOK_PAYLOAD_VERSION,
    createdAt: (a.now ?? new Date()).toISOString(),
    storeId: a.storeId,
    livemode: true,
    data: a.data,
  };
}

/** Growth / Business only (Ruling WH-1). Fails closed when the plan cannot be read. */
export async function webhookStoreEntitled(storeId: string): Promise<boolean> {
  const e = await getEntitlements(storeId);
  return !!e && planIncludesWebhooks(e.planCode);
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

async function pruneLog(db: StoreTx, storeId: string, endpointId: string): Promise<void> {
  const stale = await db.webhookDelivery.findMany({
    where: { storeId, endpointId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: WEBHOOK_LOG_KEEP_PER_ENDPOINT,
    select: { id: true },
  });
  if (stale.length > 0) {
    await db.webhookDelivery.deleteMany({
      where: { storeId, endpointId, id: { in: stale.map(s => s.id) } },
    });
  }
}

/** Create one delivery row per active, subscribed endpoint. Returns the NEW delivery ids. */
export async function fanoutWebhookEvent(storeId: string, ev: FanoutEvent): Promise<string[]> {
  const { db, onDo } = await storeRwClient(storeId);
  // The subscription test is done here, not in the query: a scalar-list filter is Postgres-only, and a store has a handful of endpoints.
  const endpoints = (
    await db.webhookEndpoint.findMany({
      where: { storeId, active: true },
      select: { id: true, includeCustomer: true, events: true },
    })
  ).filter(e => e.events.includes(ev.type));
  // Skip what already exists up front (a replay, or an endpoint that was already served), then
  // create the rest inside a SAVEPOINT: a lost unique race must never abort the surrounding tenant
  // transaction (Postgres 25P02 would fail every later insert and roll the whole fan-out back).
  const existing = new Set(
    (
      await db.webhookDelivery.findMany({
        where: { storeId, dedupeKey: ev.dedupeKey, endpointId: { in: endpoints.map(e => e.id) } },
        select: { endpointId: true },
      })
    ).map(r => r.endpointId)
  );
  const created: string[] = [];
  for (const ep of endpoints) {
    if (existing.has(ep.id)) continue;
    const eventId = stableEventId(storeId, ev.dedupeKey);
    const data =
      ep.includeCustomer && ev.customer ? { ...ev.data, customer: ev.customer } : ev.data;
    try {
      const make = () =>
        db.webhookDelivery.create({
          data: {
            storeId,
            endpointId: ep.id,
            eventId,
            eventType: ev.type,
            dedupeKey: ev.dedupeKey,
            payload: buildEnvelope({
              eventId,
              type: ev.type as WebhookEventType,
              storeId,
              data,
            }) as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
      // Postgres: a SAVEPOINT, so a lost unique race rolls back only itself. On the DO each write is its own atomic call.
      const row = await (onDo ? make() : withSavepoint(make));
      created.push(row.id);
      await pruneLog(db, storeId, ep.id);
    } catch (err) {
      // P2002 on (endpoint, dedupeKey): a concurrent run queued this event first. The savepoint
      // has already rolled the failed insert back, so the transaction is still usable.
      if ((err as { code?: string } | null)?.code === 'P2002') continue;
      throw err;
    }
  }
  return created;
}

/** A sample event for the admin "send test". Never counts toward auto-disable. */
export async function createTestDelivery(storeId: string, endpointId: string): Promise<string> {
  const { db } = await storeRwClient(storeId);
  // Ownership is checked HERE, on the SAME client the delivery is written with (Ruling CF-WEBHOOK-2): a store on its Durable Object
  // owns its endpoints there, so a check on Postgres (or by the caller on another client) would pass or fail on the wrong rows.
  const owned = await db.webhookEndpoint.findFirst({
    where: { id: endpointId, storeId },
    select: { id: true },
  });
  if (!owned) throw new Error('WEBHOOK_ENDPOINT_NOT_FOUND');
  const eventId = `evt_${randomUUID()}`;
  const row = await db.webhookDelivery.create({
    data: {
      storeId,
      endpointId,
      eventId,
      eventType: WEBHOOK_TEST_EVENT,
      isTest: true,
      payload: buildEnvelope({
        eventId,
        type: WEBHOOK_TEST_EVENT,
        storeId,
        data: { message: 'This is a test event from Ebda Store.' },
      }) as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  await pruneLog(db, storeId, endpointId);
  return row.id;
}

/** Same bytes, same event id, new delivery. null when the delivery is not this store's. */
export async function createResend(storeId: string, deliveryId: string): Promise<string | null> {
  const { db } = await storeRwClient(storeId);
  const orig = await db.webhookDelivery.findFirst({
    where: { id: deliveryId, storeId },
    select: { endpointId: true, eventId: true, eventType: true, payload: true, isTest: true },
  });
  if (!orig) return null;
  const row = await db.webhookDelivery.create({
    data: {
      storeId,
      endpointId: orig.endpointId,
      eventId: orig.eventId,
      eventType: orig.eventType,
      payload: orig.payload as Prisma.InputJsonValue,
      isTest: orig.isTest,
    },
    select: { id: true },
  });
  await pruneLog(db, storeId, orig.endpointId);
  return row.id;
}

/**
 * Backstop for the Inngest run itself failing (a DB error that outlives the step retries): the row
 * must not stay `pending`/`retrying` for ever. A delivered row is never touched.
 */
export async function markDeliveryFailed(
  storeId: string,
  deliveryId: string,
  reason: string
): Promise<void> {
  await runInStoreCtx(storeId, async () => {
    const { db } = await storeRwClient(storeId);
    return db.webhookDelivery.updateMany({
      where: { id: deliveryId, storeId, status: { in: ['pending', 'retrying'] } },
      data: { status: 'failed', error: reason.slice(0, 200), nextAttemptAt: null },
    });
  });
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

export interface AttemptOutcome {
  decision: AttemptDecision | 'skipped';
  /** True when THIS attempt tripped the auto-disable. */
  endpointDisabled: boolean;
  endpointId: string | null;
}

export async function runDeliveryAttempt(
  storeId: string,
  deliveryId: string,
  attempt: number
): Promise<AttemptOutcome> {
  const { db } = await storeRwClient(storeId);
  const loaded = await runInStoreCtx(storeId, () =>
    db.webhookDelivery.findFirst({
      where: { id: deliveryId, storeId },
      select: {
        id: true,
        eventId: true,
        eventType: true,
        payload: true,
        isTest: true,
        status: true,
        endpoint: { select: { id: true, url: true, secretEnc: true, active: true } },
      },
    })
  );
  if (!loaded || loaded.status === 'success') {
    return {
      decision: 'skipped',
      endpointDisabled: false,
      endpointId: loaded?.endpoint.id ?? null,
    };
  }
  const ep = loaded.endpoint;
  if (!ep.active && !loaded.isTest) {
    await runInStoreCtx(storeId, () =>
      db.webhookDelivery.updateMany({
        where: { id: deliveryId, storeId },
        data: { status: 'failed', error: 'endpoint_disabled', nextAttemptAt: null },
      })
    );
    return { decision: 'skipped', endpointDisabled: false, endpointId: ep.id };
  }

  // A store that dropped below Growth stops sending, including deliveries already queued (I3).
  if (!loaded.isTest && !(await webhookStoreEntitled(storeId))) {
    await runInStoreCtx(storeId, () =>
      db.webhookDelivery.updateMany({
        where: { id: deliveryId, storeId },
        data: { status: 'failed', error: 'plan_lapsed', nextAttemptAt: null },
      })
    );
    return { decision: 'skipped', endpointDisabled: false, endpointId: ep.id };
  }

  // The network call runs OUTSIDE any tenant transaction (10 s timeout vs the 30 s tx expiry). An
  // error anywhere before/around it (an undecryptable secret, a bad payload) is a FAILED ATTEMPT on
  // the normal retry schedule, never an exception that leaves the row `pending` for good (M7).
  let res: Awaited<ReturnType<typeof postWebhook>>;
  try {
    res = await postWebhook({
      url: ep.url,
      secret: encryption.decrypt(ep.secretEnc),
      body: JSON.stringify(loaded.payload),
      eventId: loaded.eventId,
      deliveryId: loaded.id,
      eventType: loaded.eventType as WebhookEventType,
    });
  } catch {
    res = { ok: false, status: null, snippet: null, error: 'internal_error', durationMs: 0 };
  }
  const decision = decideAfterAttempt({ ok: res.ok, attempt, isTest: loaded.isTest });

  return runInStoreCtx(storeId, async () => {
    const nextDelay = decision === 'retry' ? delayBeforeAttempt(attempt + 1) : 0;
    await db.webhookDelivery.updateMany({
      where: { id: deliveryId, storeId },
      data: {
        status: decision === 'success' ? 'success' : decision === 'retry' ? 'retrying' : 'failed',
        attempts: attempt,
        responseStatus: res.status,
        responseSnippet: res.snippet,
        error: res.error,
        durationMs: res.durationMs,
        nextAttemptAt: decision === 'retry' ? new Date(Date.now() + nextDelay * 1000) : null,
        deliveredAt: decision === 'success' ? new Date() : null,
      },
    });
    if (loaded.isTest) return { decision, endpointDisabled: false, endpointId: ep.id };
    if (decision === 'success') {
      await db.webhookEndpoint.updateMany({
        where: { id: ep.id, storeId },
        data: { consecutiveFailures: 0, lastSuccessAt: new Date() },
      });
      return { decision, endpointDisabled: false, endpointId: ep.id };
    }
    if (decision === 'retry') return { decision, endpointDisabled: false, endpointId: ep.id };

    // The delivery exhausted every attempt: it counts once against the endpoint.
    await db.webhookEndpoint.updateMany({
      where: { id: ep.id, storeId },
      data: { consecutiveFailures: { increment: 1 }, lastFailureAt: new Date() },
    });
    const health = await db.webhookEndpoint.findFirst({
      where: { id: ep.id, storeId },
      select: { consecutiveFailures: true },
    });
    let endpointDisabled = false;
    if (health && shouldDisableEndpoint(health.consecutiveFailures)) {
      const r = await db.webhookEndpoint.updateMany({
        where: { id: ep.id, storeId, active: true },
        data: { active: false, disabledReason: 'consecutive_failures', disabledAt: new Date() },
      });
      endpointDisabled = r.count === 1;
    }
    return { decision, endpointDisabled, endpointId: ep.id };
  });
}
