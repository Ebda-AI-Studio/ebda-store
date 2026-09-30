/**
 * Platform-wide pacer for campaign email sends (#1955).
 *
 * `campaign-send` runs one campaign per STORE at a time (Inngest concurrency
 * keyed on `event.data.storeId`), so several stores' campaigns now send in
 * parallel. Every store still shares ONE Resend API key (2 req/s default),
 * which also carries every transactional email on the platform — order
 * confirmations, password resets. The per-store sleep-after-success
 * (`CAMPAIGN_SEND_THROTTLE_MS`) cannot bound the combined rate on its own:
 * N stores at 1/s each is N/s.
 *
 * This pacer is that bound. Before each campaign send, the caller reserves the
 * next platform-wide send slot; slots are `CAMPAIGN_PLATFORM_SEND_INTERVAL_MS`
 * apart (default 1000ms → at most 1 campaign email/s across ALL stores — the
 * same ceiling the old one-campaign-at-a-time limit gave), leaving ≥1 req/s
 * of the Resend budget for transactional mail, which is not retried on 429
 * outside the order-email queue. Stores
 * interleave on the shared slot sequence, so every running campaign keeps
 * progressing — no store waits for another store's campaign to finish.
 *
 * An Inngest `throttle` is not used for this: it limits how often a function
 * RUN starts, and one run sends up to CAMPAIGN_DAILY_SEND_CAP emails, so it
 * cannot bound the per-email rate.
 *
 * Coordination is a single Redis key holding the next free slot time (ms),
 * advanced atomically in Lua using Redis's own clock, so it holds across API
 * replicas. Without Redis it falls back to an in-process slot, which is still
 * a global bound on a single replica (the production shape) and never
 * blocks sending.
 */
import { redis } from '../services/redis.service';
import logger from './logger';

const PACER_KEY = 'campaign:send-pacer:next-slot';
/** The key only needs to outlive the slots it has handed out. */
const PACER_KEY_TTL_MS = 5 * 60 * 1000;

/** Minimum gap between ANY two campaign sends, platform-wide. */
export function campaignPlatformSendIntervalMs(): number {
  const n = parseInt(process.env.CAMPAIGN_PLATFORM_SEND_INTERVAL_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

// KEYS[1] = pacer key; ARGV[1] = interval ms; ARGV[2] = key TTL ms;
// ARGV[3] = max wait ms the caller can afford (-1 = unbounded).
// Returns { wait ms, 1 if the slot was reserved else 0 }.
//
// The reservation is CONDITIONAL (issue 2298): a caller that cannot afford the
// wait leaves the horizon untouched. Reserving first and then deferring
// consumed one platform slot per deferral for zero emails, so under load every
// deferral pushed the horizon further out and no store ever sent again.
const RESERVE_SLOT_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local nextSlot = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, nextSlot)
local maxWait = tonumber(ARGV[3])
if maxWait >= 0 and (slot - now) > maxWait then
  return { slot - now, 0 }
end
redis.call('SET', KEYS[1], tostring(slot + tonumber(ARGV[1])), 'PX', ARGV[2])
return { slot - now, 1 }
`;

let localNextSlot = 0;

interface Reservation {
  waitMs: number;
  reserved: boolean;
}

/** In-process twin of RESERVE_SLOT_LUA — same conditional reservation. */
function reserveLocalSlot(intervalMs: number, maxWaitMs: number): Reservation {
  const now = Date.now();
  const slot = Math.max(now, localNextSlot);
  if (slot - now > maxWaitMs) return { waitMs: slot - now, reserved: false };
  localNextSlot = slot + intervalMs;
  return { waitMs: slot - now, reserved: true };
}

async function reserveSlot(intervalMs: number, maxWaitMs: number): Promise<Reservation> {
  const client = redis.getClient();
  if (client && redis.isAvailable()) {
    try {
      const res = (await client.eval(
        RESERVE_SLOT_LUA,
        1,
        PACER_KEY,
        String(intervalMs),
        String(PACER_KEY_TTL_MS),
        String(Number.isFinite(maxWaitMs) ? Math.max(0, Math.floor(maxWaitMs)) : -1)
      )) as unknown;
      const waitMs = Math.max(0, Number(Array.isArray(res) ? res[0] : res) || 0);
      const reserved = Array.isArray(res) ? Number(res[1]) === 1 : waitMs <= maxWaitMs;
      return { waitMs, reserved };
    } catch (err) {
      logger.warn({ err }, '[CAMPAIGN] send pacer: Redis reserve failed, using in-process slot');
    }
  }
  return reserveLocalSlot(intervalMs, maxWaitMs);
}

/**
 * Wait until this process may make its next campaign send. Call it
 * immediately before each `sendMarketingEmail`.
 *
 * `maxWaitMs` (issue 2115): the wait grows with the number of stores sending
 * at once (one shared slot per interval), and the caller is inside ONE
 * Inngest step = one HTTP request behind Cloudflare's 100s edge timeout. When
 * the next slot is further away than the caller can afford, this returns
 * `false` WITHOUT waiting and WITHOUT reserving — the shared horizon is left
 * exactly where it was (issue 2298), so a deferral never removes capacity
 * from the other stores — and the caller ends its step and resumes in the
 * next one. Returns `true` when the caller may send now.
 */
export async function awaitCampaignSendSlot(maxWaitMs = Infinity): Promise<boolean> {
  const intervalMs = campaignPlatformSendIntervalMs();
  if (intervalMs <= 0) return true;
  const { waitMs: wait, reserved } = await reserveSlot(intervalMs, maxWaitMs);
  if (!reserved) {
    logger.info(
      { waitMs: wait, maxWaitMs },
      "[CAMPAIGN] send pacer: next slot is past this step's budget — resuming in the next step"
    );
    return false;
  }
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  return true;
}

/** Test-only: forget the in-process slot. */
export function __resetCampaignSendPacerForTests(): void {
  localNextSlot = 0;
}
