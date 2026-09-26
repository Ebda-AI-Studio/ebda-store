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

// KEYS[1] = pacer key; ARGV[1] = interval ms; ARGV[2] = key TTL ms.
// Returns how long the caller must wait before its reserved slot, in ms.
const RESERVE_SLOT_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local nextSlot = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, nextSlot)
redis.call('SET', KEYS[1], tostring(slot + tonumber(ARGV[1])), 'PX', ARGV[2])
return slot - now
`;

let localNextSlot = 0;

function reserveLocalSlot(intervalMs: number): number {
  const now = Date.now();
  const slot = Math.max(now, localNextSlot);
  localNextSlot = slot + intervalMs;
  return slot - now;
}

async function reserveSlot(intervalMs: number): Promise<number> {
  const client = redis.getClient();
  if (client && redis.isAvailable()) {
    try {
      const wait = await client.eval(
        RESERVE_SLOT_LUA,
        1,
        PACER_KEY,
        String(intervalMs),
        String(PACER_KEY_TTL_MS)
      );
      return Math.max(0, Number(wait) || 0);
    } catch (err) {
      logger.warn({ err }, '[CAMPAIGN] send pacer: Redis reserve failed, using in-process slot');
    }
  }
  return reserveLocalSlot(intervalMs);
}

/**
 * Wait until this process may make its next campaign send. Call it
 * immediately before each `sendMarketingEmail`.
 */
export async function awaitCampaignSendSlot(): Promise<void> {
  const intervalMs = campaignPlatformSendIntervalMs();
  if (intervalMs <= 0) return;
  const wait = await reserveSlot(intervalMs);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

/** Test-only: forget the in-process slot. */
export function __resetCampaignSendPacerForTests(): void {
  localNextSlot = 0;
}
