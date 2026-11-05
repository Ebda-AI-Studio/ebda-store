/**
 * The CI sink: Queue `ebda-ci-events` -> R2 `ebda-ci` (source of truth, with `buyerKey`) + Analytics Engine
 * `ebda_commerce_outcomes` (dashboards, NO buyer key, NO order id). Layout and erasure contract:
 * docs/plans/2026-10-28-customer-intelligence.md 1.5, 1.6 and cf/erasure/surfaces.ts (`ciSurface` reads
 * exactly what this writes: gzip NDJSON with a top-level `buyerKey`, and `index/buyer/xx/<key>.json`).
 *
 * Delivery is at-least-once. Duplicates are dropped here by a best-effort KV marker (written AFTER the
 * write, so a crash replays rather than loses) and, authoritatively, by `eventId` in the compaction and
 * CI-2 readers (the envelope id is deterministic per occurrence). An unreadable message is RETRIED into
 * the DLQ (never silently acked: capture is the unrecoverable half) and pages.
 */
import type { AnalyticsEngineLike, CfBindings, R2BucketCasLike } from '../../cf/bindings';
import { cfBindings } from '../../cf/bindings';
import type { MessageBatchLike } from '../../cf/queues';
import { sendAlert } from '../../services/alerts.service';
import logger from '../logger';
import { CI_EVENTS_DLQ } from './config';
import {
  ciBuyerIndexKey,
  ciBuyerTombstoneKey,
  ciDlqKey,
  ciOrderTombstoneKey,
  ciPartitionPrefix,
} from './layout';
import { deterministicEventId, parseEnvelope, type CiEnvelope } from './envelope';

/** Same curve as cf/queues.ts retryDelaySeconds (not imported: that module pulls the database into this one). */
const retryDelaySeconds = (attempts: number) => Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));

const SEEN_TTL_SECONDS = 7 * 24 * 3600;
const INDEX_CAS_ATTEMPTS = 6;
const OTHER_RATE_MIN_RETURNS = 10;
const OTHER_RATE_THRESHOLD = 0.2;

export { ciBuyerIndexKey, ciPartitionPrefix };
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function gzip(text: string): Promise<Uint8Array> {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ---------------------------------------------------------------- Analytics Engine

type D = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** One data point per event (section 1.5). Never `buyerKey`, never `orderId`. */
export function toAnalyticsPoint(e: CiEnvelope): {
  indexes: string[];
  blobs: string[];
  doubles: number[];
} {
  const d = e.data as D;
  const hours = num(d.hoursSincePickup ?? d.hoursSinceCreated ?? d.minutesToConfirm);
  return {
    indexes: [e.storeId],
    blobs: [
      e.type,
      e.product,
      str(d.carrier),
      str(d.areaKey),
      str(d.paymentMethod) || str(d.provider),
      str(d.returnReasonCode) || str(d.reasonCode) || str(d.failureCode) || str(d.step),
      e.xstore ? '1' : '0',
      String(e.v),
    ],
    doubles: [
      num(d.totalMinor ?? d.codMinor),
      hours,
      num(d.attempts ?? d.attemptNo ?? d.attemptsToBook),
      e.occurredAt,
    ],
  };
}

// ---------------------------------------------------------------- R2

async function addToBuyerIndex(
  ci: R2BucketCasLike,
  buyerKey: string,
  partition: string
): Promise<void> {
  const key = ciBuyerIndexKey(buyerKey);
  for (let attempt = 0; attempt < INDEX_CAS_ATTEMPTS; attempt++) {
    const cur = await ci.get(key);
    const partitions: string[] = cur ? (JSON.parse(await cur.text()).partitions ?? []) : [];
    if (partitions.includes(partition)) return;
    const next = JSON.stringify({ partitions: [...partitions, partition] });
    const done = await ci.put(key, next, {
      onlyIf: cur ? { etagMatches: cur.etag } : { etagDoesNotMatch: '*' },
    });
    if (done) return;
  }
  throw new Error(`buyer index contention: ${key}`);
}

/** Writes one (store, day) group. Index FIRST: an index entry for a partition that never landed is skipped by erasure; the reverse would be an unerasable row. */
async function writeGroup(
  ci: R2BucketCasLike,
  storeId: string,
  day: string,
  events: CiEnvelope[]
): Promise<void> {
  const name = await deterministicEventId(
    `batch:${events
      .map(e => e.eventId)
      .sort()
      .join(',')}`
  );
  const partition = `${ciPartitionPrefix(storeId, day)}${name}.ndjson.gz`;
  for (const k of new Set(events.map(e => e.buyerKey).filter((k): k is string => !!k))) {
    await addToBuyerIndex(ci, k, partition);
  }
  const body = await gzip(events.map(e => JSON.stringify(e)).join('\n') + '\n');
  // Create-only: a retry of the same group finds its own object and is done.
  await ci.put(partition, body, { onlyIf: { etagDoesNotMatch: '*' } });
}

// ---------------------------------------------------------------- stale-mapper alert

interface KvLike {
  get(k: string): Promise<string | null>;
  put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>;
}

/** `other` above 20% of a carrier's returns this month = the return-reason table is stale. Bounded-stale (KV); alerts once a month per carrier. */
async function trackOtherRate(kv: KvLike | undefined, e: CiEnvelope): Promise<void> {
  if (!kv || e.type !== 'shipment.returned') return;
  const carrier = e.data.carrier;
  const key = `ci-ret:${carrier}:${utcDay(e.recordedAt).slice(0, 7)}`;
  const cur = JSON.parse((await kv.get(key)) ?? '{"n":0,"other":0,"alerted":false}') as {
    n: number;
    other: number;
    alerted: boolean;
  };
  cur.n += 1;
  if (e.data.returnReasonCode === 'other') cur.other += 1;
  if (!cur.alerted && cur.n >= OTHER_RATE_MIN_RETURNS && cur.other / cur.n > OTHER_RATE_THRESHOLD) {
    cur.alerted = true;
    await sendAlert({
      level: 'info',
      scope: 'platform',
      source: 'ci.return_reason_stale',
      title: `CI return-reason mapper looks stale for ${carrier}`,
      body: `${cur.other} of ${cur.n} ${carrier} returns this month mapped to "other". Update the phrase table in lib/ci/return-reason.ts.`,
    }).catch(() => undefined);
  }
  await kv.put(key, JSON.stringify(cur), { expirationTtl: 40 * 24 * 3600 });
}

// ---------------------------------------------------------------- queue entry

export async function handleCiEventsBatch(
  batch: MessageBatchLike,
  env: Pick<CfBindings, 'CI_BUCKET' | 'CI_OUTCOMES' | 'KV_CACHE'> | undefined = cfBindings()
): Promise<void> {
  if (batch.queue === CI_EVENTS_DLQ) {
    const bucket = env?.CI_BUCKET as R2BucketCasLike | undefined;
    for (const msg of batch.messages) {
      // Acking a DLQ message deletes it, so the body is parked in R2 first (`dlq/`, expires after 14 days;
      // it holds at most the pseudonymous envelope) and the message is only acked once that write landed.
      if (bucket) {
        // An event for an order / buyer erased since it was queued is not parked (it would keep the key for 14 days).
        const b = (msg.body ?? {}) as { orderId?: unknown; storeId?: unknown; buyerKey?: unknown };
        if (
          (typeof b.orderId === 'string' && (await bucket.get(ciOrderTombstoneKey(b.orderId)))) ||
          (typeof b.storeId === 'string' &&
            typeof b.buyerKey === 'string' &&
            (await bucket.get(ciBuyerTombstoneKey(b.storeId, b.buyerKey))))
        ) {
          msg.ack();
          continue;
        }
        try {
          await bucket.put(
            ciDlqKey(msg.id),
            JSON.stringify({ parkedAt: Date.now(), body: msg.body })
          );
        } catch (err) {
          logger.error({ err, id: msg.id }, '[ci] could not park a dead-lettered event, retrying');
          msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
          continue;
        }
      } else {
        logger.error({ id: msg.id }, '[ci] no CI_BUCKET to park a dead letter in, retrying');
        msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
        continue;
      }
      logger.error({ id: msg.id }, '[ci] dead-lettered outcome event (not captured)');
      await sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'ci.dead_letter',
        title: 'A Customer Intelligence outcome could not be captured',
        body: `Message ${msg.id} on the CI events queue exhausted its retries. Capture is unrecoverable data: the body is parked in R2 ebda-ci under dlq/ (14 days); replay it after fixing the cause.`,
      }).catch(() => undefined);
      msg.ack();
    }
    return;
  }
  const ci = env?.CI_BUCKET as R2BucketCasLike | undefined;
  const ae = env?.CI_OUTCOMES as AnalyticsEngineLike | undefined;
  const kv = env?.KV_CACHE as unknown as KvLike | undefined;
  if (!ci) throw new Error('CI_BUCKET binding missing'); // whole batch retries; boot assert catches it first

  const fresh: Array<{ msg: MessageBatchLike['messages'][number]; env: CiEnvelope }> = [];
  for (const msg of batch.messages) {
    let e: CiEnvelope;
    try {
      e = parseEnvelope(msg.body);
    } catch (err) {
      logger.error({ err, id: msg.id }, '[ci] unreadable outcome event, retrying toward the DLQ');
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
      continue;
    }
    // Erased since this event was queued (retry / DLQ replay): an erased order's event is dropped, an
    // erased buyer's key is removed (the outcome stays, anonymous).
    if (e.orderId && (await ci.get(ciOrderTombstoneKey(e.orderId)))) {
      msg.ack();
      continue;
    }
    if (e.buyerKey && (await ci.get(ciBuyerTombstoneKey(e.storeId, e.buyerKey))))
      e = { ...e, buyerKey: null };
    if (kv && (await kv.get(`ci-seen:${e.eventId}`).catch(() => null))) {
      msg.ack();
      continue;
    }
    fresh.push({ msg, env: e });
  }

  const groups = new Map<string, typeof fresh>();
  for (const f of fresh) {
    const k = `${f.env.storeId}|${utcDay(f.env.recordedAt)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  for (const [k, items] of groups) {
    const [storeId, day] = k.split('|') as [string, string];
    try {
      await writeGroup(
        ci,
        storeId,
        day,
        items.map(i => i.env)
      );
    } catch (err) {
      logger.warn({ err, storeId }, '[ci] R2 write failed, retrying');
      for (const i of items) i.msg.retry({ delaySeconds: retryDelaySeconds(i.msg.attempts) });
      continue;
    }
    for (const { msg, env: e } of items) {
      try {
        ae?.writeDataPoint(toAnalyticsPoint(e));
        await trackOtherRate(kv, e);
        await kv?.put(`ci-seen:${e.eventId}`, '1', { expirationTtl: SEEN_TTL_SECONDS });
      } catch (err) {
        // R2 (the source of truth) has it: dashboards/markers are best effort, never a reason to rewrite.
        logger.warn({ err, id: msg.id }, '[ci] post-write bookkeeping failed');
      }
      msg.ack();
    }
  }
}
