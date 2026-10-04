/**
 * Card-testing guard for STOREFRONT online payments (SP5 task 4).
 *
 * "Card testing" = a script walks a list of stolen card numbers through a
 * merchant's checkout to learn which still work. It shows up as many online
 * payment attempts from one place, most of them declined. Controls, all
 * provider-agnostic (they key on store / IP / checkout session, never on a
 * gateway, so SP6 providers inherit them):
 *
 *   1. per-store  attempt budget   PAYMENT_ATTEMPTS_PER_STORE_10M  (120 / 10 min)
 *   2. per-IP     attempt budget   PAYMENT_ATTEMPTS_PER_IP_10M     (10 / 10 min)
 *   3. per-session decline counter PAYMENT_SESSION_MAX_DECLINES    (5 declines
 *      => the session is blocked for an hour), plus a per-IP decline counter
 *      PAYMENT_IP_MAX_DECLINES (10 / hour) so rotating the session id does not help.
 *   4. alert: when a store's declines / attempts in the hour reaches
 *      PAYMENT_ALERT_DECLINE_RATIO (0.6) with at least PAYMENT_ALERT_MIN_ATTEMPTS
 *      (20) attempts, a store-scoped P1 goes to the existing alerts channel.
 *
 * COD never reaches this guard (no card is involved): the caller passes
 * `provider === 'cod'` and gets an immediate pass.
 *
 * Counters are Redis fixed windows (10-minute / hourly buckets). Redis down =>
 * fail OPEN (availability over strictness, same posture as the shared
 * limiters). Only a `failed` (declined) payment counts as a decline: a customer
 * who abandons or cancels at the gateway ('cancelled' / 'expired') is not a
 * card tester.
 */
import { ipKeyGenerator } from 'express-rate-limit';
import { prisma } from '@force/database';
import { abuseConfig } from '../lib/abuse-config';
import logger from '../lib/logger';
import { AppError } from '../middleware/error-handler';
import { sendAlert } from './alerts.service';
import { redis } from './redis.service';

const TEN_MIN_S = 10 * 60;
const HOUR_S = 60 * 60;

export interface PaymentAttemptContext {
  storeId: string;
  orderId: string;
  /** Gateway id ('paymob', 'kashier', 'cod', …). `cod` is exempt. */
  provider: string;
  /** Client IP (`req.ip`). */
  ip: string | undefined;
  /** The checkout session (`x-session-id`), when the client sent one. */
  sessionId?: string | undefined;
}

/** IPv6 folded to its /64 so a client cannot rotate through its own block. */
function ipKey(ip: string | undefined): string {
  return ipKeyGenerator((ip ?? '').replace(/^::ffff:/i, '') || 'unknown', 64);
}

function cleanSession(id: string | undefined): string | null {
  const v = (id ?? '').trim();
  return v && v.length <= 128 ? v : null;
}

const bucket = (seconds: number, now: number) => Math.floor(now / 1000 / seconds);

async function incr(key: string, ttlSeconds: number): Promise<number | null> {
  const client = redis.getClient();
  if (!client || !redis.isAvailable()) return null;
  const n = await client.incr(key);
  if (n === 1) await client.expire(key, ttlSeconds);
  return n;
}

async function readCount(key: string): Promise<number> {
  const client = redis.getClient();
  if (!client || !redis.isAvailable()) return 0;
  const v = await client.get(key);
  return v ? Number.parseInt(v, 10) || 0 : 0;
}

const sessionDeclineKey = (storeId: string, session: string) =>
  `cardtest:sess-declines:${storeId}:${session}`;
const ipDeclineKey = (ip: string) => `cardtest:ip-declines:${ip}`;
const ctxKey = (orderId: string) => `cardtest:ctx:${orderId}`;

export class CardTestingGuard {
  /**
   * Gate ONE online payment initiation. Throws a 429 `AppError`
   * (`PAYMENT_BLOCKED` for a session/IP past its decline budget,
   * `PAYMENT_RATE_LIMITED` for the attempt budgets); returns when allowed.
   * Records the attempt (and which session/IP made it, so a later decline can
   * be attributed) only when allowed.
   */
  static async assertAllowed(ctx: PaymentAttemptContext, now: number = Date.now()): Promise<void> {
    if (ctx.provider === 'cod') return; // COD: no card, unaffected
    try {
      const ip = ipKey(ctx.ip);
      const session = cleanSession(ctx.sessionId);

      // Declines first: a blocked session/IP must not even consume attempt budget.
      if (session) {
        const declines = await readCount(sessionDeclineKey(ctx.storeId, session));
        if (declines >= abuseConfig.paymentSessionMaxDeclines()) {
          logger.warn({ storeId: ctx.storeId, declines }, 'card-testing: session blocked');
          throw blocked();
        }
      }
      if ((await readCount(ipDeclineKey(ip))) >= abuseConfig.paymentIpMaxDeclines()) {
        logger.warn({ storeId: ctx.storeId }, 'card-testing: ip blocked after repeated declines');
        throw blocked();
      }

      const b = bucket(TEN_MIN_S, now);
      const perIp = await incr(`cardtest:ip:${ip}:${b}`, 2 * TEN_MIN_S);
      if (perIp !== null && perIp > abuseConfig.paymentAttemptsPerIp10m()) {
        throw rateLimited();
      }
      const perStore = await incr(`cardtest:store:${ctx.storeId}:${b}`, 2 * TEN_MIN_S);
      if (perStore !== null && perStore > abuseConfig.paymentAttemptsPerStore10m()) {
        throw rateLimited();
      }

      // Attribution for a later decline + the hourly denominator for the alert.
      await incr(`cardtest:attempts:${ctx.storeId}:${bucket(HOUR_S, now)}`, 2 * HOUR_S);
      const client = redis.getClient();
      if (client && redis.isAvailable()) {
        await client.set(ctxKey(ctx.orderId), JSON.stringify({ ip, session }), 'EX', 2 * HOUR_S);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.warn({ err }, 'card-testing guard check failed; allowing');
    }
  }

  /**
   * Record that the payment for `orderId` was DECLINED (provider status
   * `failed`). Idempotent per payment (webhooks are retried). Never throws:
   * called from webhook / reconcile paths that must not fail on bookkeeping.
   * Raises the decline-spike alert when the store's rate crosses the threshold.
   */
  static async recordDecline(
    input: { storeId: string; orderId: string; paymentId: string },
    now: number = Date.now()
  ): Promise<{ counted: boolean; alerted: boolean }> {
    try {
      const client = redis.getClient();
      if (!client || !redis.isAvailable()) return { counted: false, alerted: false };

      // One decline per payment, however many times the webhook / reconcile fires.
      const first = await client.set(
        `cardtest:declined:${input.paymentId}`,
        '1',
        'EX',
        2 * HOUR_S,
        'NX'
      );
      if (first !== 'OK') return { counted: false, alerted: false };

      let ip: string | null = null;
      let session: string | null = null;
      const raw = await client.get(ctxKey(input.orderId));
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { ip?: string; session?: string | null };
          ip = parsed.ip ?? null;
          session = parsed.session ?? null;
        } catch {
          /* unattributable decline: still counts for the store */
        }
      }
      if (session) await incr(sessionDeclineKey(input.storeId, session), HOUR_S);
      if (ip) await incr(ipDeclineKey(ip), HOUR_S);

      const hour = bucket(HOUR_S, now);
      const declines =
        (await incr(`cardtest:store-declines:${input.storeId}:${hour}`, 2 * HOUR_S)) ?? 0;
      const attempts = await readCount(`cardtest:attempts:${input.storeId}:${hour}`);

      const spike =
        attempts >= abuseConfig.paymentAlertMinAttempts() &&
        declines / attempts >= abuseConfig.paymentAlertDeclineRatio();
      if (!spike) return { counted: true, alerted: false };

      // At most one alert per store per hour (the alerts service also throttles by title).
      const once = await client.set(
        `cardtest:alerted:${input.storeId}:${hour}`,
        '1',
        'EX',
        2 * HOUR_S,
        'NX'
      );
      if (once !== 'OK') return { counted: true, alerted: false };

      const store = await prisma.store.findUnique({
        where: { id: input.storeId },
        select: { id: true, name: true, slug: true },
      });
      void sendAlert({
        level: 'p1',
        scope: 'store',
        store: { id: input.storeId, name: store?.name ?? input.storeId, slug: store?.slug },
        source: 'payment.card_testing.decline_spike',
        title: 'payment decline-rate spike (possible card testing)',
        body: `${declines} of ${attempts} online payment attempts this hour were declined (${Math.round(
          (declines / attempts) * 100
        )}%).`,
        context: { declines, attempts, ratio: Number((declines / attempts).toFixed(2)) },
      }).catch(() => undefined);
      return { counted: true, alerted: true };
    } catch (err) {
      logger.warn(
        { err, storeId: input.storeId, orderId: input.orderId, paymentId: input.paymentId },
        'card-testing: recording a decline failed'
      );
      return { counted: false, alerted: false };
    }
  }
}

function blocked(): AppError {
  return new AppError(
    429,
    'PAYMENT_BLOCKED',
    'Too many declined payments. Please try again later or choose another payment method.'
  );
}

function rateLimited(): AppError {
  return new AppError(
    429,
    'PAYMENT_RATE_LIMITED',
    'Too many payment attempts. Please wait a few minutes and try again.'
  );
}
