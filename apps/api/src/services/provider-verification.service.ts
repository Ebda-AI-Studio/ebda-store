/**
 * Ruling PROVIDERS-3: the first merchants' own credentials are a provider's verification.
 *
 * `recordProviderOperation` is called at the real choke points (a payment invoice created or
 * confirmed paid, a shipment booked) and does three things for a provider the catalog does not yet
 * list as verified:
 *   1. appends evidence (store, mode, op, outcome, reference, error CODE; never a credential or a body);
 *   2. pages ops (P1, store scope) on the FIRST real use of the provider by a store, and on every
 *      failed operation while the provider is still unverified (the alert service throttles repeats);
 *   3. marks the provider READY once enough DISTINCT stores each settled a LIVE operation
 *      (payment confirmed paid, shipment booked; sandbox and invoice-only operations never count).
 * Ready is not verified: only a super admin confirm (`confirmProviderVerification`) sets
 * `verified_at`, because that is what silences the alerts for every store. A single merchant can
 * therefore never verify a provider for the platform.
 *
 * It NEVER throws. Callers run it through `deferAfterTenantCommit` so it never shares (or poisons)
 * a request transaction, and never delays the money path.
 * `isProviderVerified` is BOUNDED-stale (60 s in-process cache): bookkeeping and display only.
 */
import { storeDb } from '../lib/repo-factory';
import { readInStoreContext } from '../lib/store-scoped-read';
import { prisma, withStore } from '@ebda/database';
import {
  AUTO_VERIFY_AFTER_DEFAULT,
  PROVIDER_CATALOG,
  getProviderEntry,
  type ProviderKind,
} from '@ebda/shared';
import logger from '../lib/logger';
import { AppError } from '../middleware/error-handler';
import { sendAlert } from './alerts.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { withClaimLock } from '../lib/claim-lock';

export type ProviderOp = 'create_payment' | 'payment_confirmed' | 'create_shipment';

/** Operations that prove a flow end to end (money settled / parcel booked). */
const SETTLED_OPS: ReadonlySet<ProviderOp> = new Set(['payment_confirmed', 'create_shipment']);

export interface ProviderOperation {
  storeId: string;
  provider: string;
  op: ProviderOp;
  ok: boolean;
  /** Provider-side or Ebda-side reference (invoice id, tracking number). No secret. */
  ref?: string | null;
  /** A short code (error class / provider code); never a raw provider body. */
  errorCode?: string | null;
  /** Override the mode lookup (tests); normally read from the store's connection row. */
  mode?: 'sandbox' | 'live';
}

/** Events kept per provider besides first uses and counted successes (evidence for humans). */
const EVENT_CAP = 200;
const CACHE_TTL_MS = 60_000;

/** DISTINCT stores that must each settle a live operation before a provider is "ready". */
export function autoVerifyAfter(): number {
  const n = Number(process.env.PROVIDER_AUTO_VERIFY_AFTER);
  return Number.isInteger(n) && n > 0 ? n : AUTO_VERIFY_AFTER_DEFAULT;
}

let verifiedCache: { at: number; codes: Set<string> } | null = null;

/** Test seam. */
export function resetProviderVerificationCache(): void {
  verifiedCache = null;
}

async function verifiedCodes(): Promise<Set<string>> {
  const now = Date.now();
  if (verifiedCache && now - verifiedCache.at < CACHE_TTL_MS) return verifiedCache.codes;
  const rows = await prisma.providerVerification.findMany({
    where: { verifiedAt: { not: null } },
    select: { provider: true },
  });
  verifiedCache = { at: now, codes: new Set(rows.map(r => r.provider)) };
  return verifiedCache.codes;
}

/** Catalog-verified OR confirmed by a super admin from real traffic. */
export async function isProviderVerified(code: string): Promise<boolean> {
  const entry = getProviderEntry(code);
  if (!entry) return false;
  if (entry.manual || entry.verified) return true;
  try {
    return (await verifiedCodes()).has(code);
  } catch (err) {
    logger.warn({ err, provider: code }, '[PROVIDER-VERIFY] could not read verification state');
    return false;
  }
}

/** The mode the store's connection runs in now. Unknown => sandbox (never counts). */
async function modeOf(
  storeId: string,
  provider: string,
  kind: ProviderKind
): Promise<'sandbox' | 'live'> {
  try {
    // Both configs are per-store rows: the store's DO (no Postgres in the Worker) or its Postgres tenant scope.
    const testMode = await readInStoreContext(storeId, async () => {
      const db = await storeDb(storeId);
      if (kind === 'payments') {
        const r = await db.paymentConfig.findFirst({
          where: { storeId, provider },
          select: { testMode: true },
        });
        return r?.testMode;
      }
      const r = await db.shippingCarrierConfig.findUnique({
        where: { storeId_carrier: { storeId, carrier: provider } },
        select: { testMode: true },
      });
      return r?.testMode;
    });
    return testMode === false ? 'live' : 'sandbox';
  } catch {
    return 'sandbox';
  }
}

async function storeContext(storeId: string): Promise<{ id: string; name: string; slug?: string }> {
  try {
    const s = await withStore(storeId, tx =>
      tx.store.findFirst({ where: { id: storeId }, select: { name: true, slug: true } })
    );
    if (s) return { id: storeId, name: s.name, slug: s.slug };
  } catch {
    // fall through: the alert still carries the id
  }
  return { id: storeId, name: storeId };
}

export async function recordProviderOperation(input: ProviderOperation): Promise<void> {
  try {
    const entry = getProviderEntry(input.provider);
    if (!entry || entry.manual || entry.verified) return;
    if ((await verifiedCodes()).has(input.provider)) return;

    const mode = input.mode ?? (await modeOf(input.storeId, input.provider, entry.kind));
    const counted = input.ok && mode === 'live' && SETTLED_OPS.has(input.op);

    const prior = await prisma.providerVerificationEvent.findFirst({
      // The activation ledger (op `activation.*`) is not a REAL use: it must not hide the first-real-use alert.
      where: {
        provider: input.provider,
        sourceStoreId: input.storeId,
        NOT: { op: { startsWith: 'activation.' } },
      },
      select: { id: true },
    });
    const firstUse = prior === null;

    const counters = await prisma.providerVerification.upsert({
      where: { provider: input.provider },
      create: {
        provider: input.provider,
        kind: entry.kind,
        successCount: input.ok ? 1 : 0,
        failureCount: input.ok ? 0 : 1,
      },
      update: input.ok ? { successCount: { increment: 1 } } : { failureCount: { increment: 1 } },
    });

    if (firstUse || counted || counters.successCount + counters.failureCount <= EVENT_CAP) {
      await prisma.providerVerificationEvent.create({
        data: {
          provider: input.provider,
          sourceStoreId: input.storeId,
          op: input.op,
          ok: input.ok,
          mode,
          counted,
          ref: input.ref ?? null,
          errorCode: input.errorCode ?? null,
        },
      });
    }

    if (firstUse || !input.ok) {
      await alertUnverifiedUse(input, entry.kind, firstUse, mode);
    }

    if (counted && !counters.readyAt) {
      const stores = await prisma.providerVerificationEvent.groupBy({
        by: ['sourceStoreId'],
        where: { provider: input.provider, counted: true },
      });
      if (stores.length >= autoVerifyAfter()) {
        // On D1 an updateMany count is not atomic (SELECT keys, then a write per key): serialise the flip so only one
        // caller sees count 1 and sends the alert. Someone else holding the claim is flipping it: skip.
        await withClaimLock(
          `provider-ready:${input.provider}`,
          30,
          async () => {
            const flipped = await prisma.providerVerification.updateMany({
              where: { provider: input.provider, readyAt: null },
              data: { readyAt: new Date() },
            });
            if (flipped.count === 1) {
              await sendAlert({
                level: 'info',
                source: 'provider.ready_to_verify',
                title: `Provider ready to verify: ${input.provider}`,
                body: `${stores.length} distinct stores settled real LIVE operations on ${input.provider}. Review the evidence on /provider-activation and confirm to mark it verified (until then first-use and failure alerts keep firing).`,
                context: { provider: input.provider, kind: entry.kind, stores: stores.length },
              });
            }
          },
          { failOpen: true }
        );
      }
    }
  } catch (err) {
    logger.warn(
      { err, provider: input.provider, storeId: input.storeId, op: input.op },
      '[PROVIDER-VERIFY] could not record provider operation'
    );
  }
}

/**
 * The ONE evidence call for a payment that settled, used by every confirm path (the pull-side
 * confirm service AND the provider webhook). Runs after the tenant commit, never throws.
 */
export function recordPaymentSettled(input: {
  storeId: string;
  provider: string;
  paymentId: string;
}): Promise<unknown> {
  return deferAfterTenantCommit('provider-verify.payment_confirmed', () =>
    recordProviderOperation({
      storeId: input.storeId,
      provider: input.provider,
      op: 'payment_confirmed',
      ok: true,
      ref: input.paymentId,
    })
  );
}

/**
 * Super admin confirm: only a provider that reached "ready" (enough distinct stores settled live
 * operations) can be marked verified. Sets `verified_at`, which silences the unverified alerts.
 */
export async function confirmProviderVerification(
  provider: string,
  actorUserId: string
): Promise<{ provider: string; verifiedAt: string }> {
  const entry = getProviderEntry(provider);
  if (!entry || entry.manual) {
    throw new AppError(404, 'UNKNOWN_PROVIDER', `Unknown provider "${provider}"`);
  }
  if (entry.verified) {
    throw new AppError(409, 'ALREADY_VERIFIED', `${provider} is already verified in the catalog`);
  }
  const now = new Date();
  // Serialised (D1 updateMany counts are not atomic): exactly one confirm wins, the rest answer 409, fail closed.
  const claim = await withClaimLock(`provider-confirm:${provider}`, 30, () =>
    prisma.providerVerification.updateMany({
      where: { provider, readyAt: { not: null }, verifiedAt: null },
      data: { verifiedAt: now, verifiedById: actorUserId },
    })
  );
  if (!claim.acquired || claim.value.count !== 1) {
    throw new AppError(
      409,
      'NOT_READY',
      `${provider} is not ready to verify yet (needs ${autoVerifyAfter()} distinct stores with settled live operations) or is already confirmed`
    );
  }
  verifiedCache = null;
  return { provider, verifiedAt: now.toISOString() };
}

async function alertUnverifiedUse(
  input: ProviderOperation,
  kind: ProviderKind,
  firstUse: boolean,
  mode: 'sandbox' | 'live'
): Promise<void> {
  const store = await storeContext(input.storeId);
  const outcome = input.ok ? 'SUCCESS' : `FAILED${input.errorCode ? ` (${input.errorCode})` : ''}`;
  await sendAlert({
    level: 'p1',
    scope: 'store',
    store,
    source: firstUse ? 'provider.unverified.first_use' : 'provider.unverified.failure',
    title: firstUse
      ? `First real use of unverified ${kind} provider ${input.provider}`
      : `Unverified ${kind} provider ${input.provider} operation failed`,
    body:
      `${input.provider} (${input.op}, ${mode}) ${outcome} for store ${store.name}. ` +
      'This provider has never been verified against a real account: fix any integration error now.',
    context: {
      provider: input.provider,
      op: input.op,
      mode,
      outcome,
      ref: input.ref ?? null,
      storeId: input.storeId,
    },
  });
}

/**
 * A connection check whose answer the adapter does not recognise (code `unknown`) pages ops: the
 * merchant is told Ebda support has been informed (see `describeConnectionCheck`), so it must be
 * true. Other outcomes (wrong credentials, unreachable, no_check) are the merchant's to fix.
 * Never throws.
 */
export async function reportConnectionCheck(input: {
  storeId: string;
  provider: string;
  mode: string;
  code: string;
}): Promise<void> {
  if (input.code !== 'unknown') return;
  try {
    const entry = getProviderEntry(input.provider);
    if (!entry || entry.manual) return;
    await sendAlert({
      level: 'p1',
      scope: 'store',
      store: await storeContext(input.storeId),
      source: 'provider.connection_check.unrecognized',
      title: `Unrecognised connection-check answer from ${input.provider}`,
      body: `The ${input.provider} connection check (${input.mode}) returned an answer the adapter does not recognise. Likely an integration mismatch: inspect the adapter against the provider docs.`,
      context: { provider: input.provider, mode: input.mode, storeId: input.storeId },
    });
  } catch (err) {
    logger.warn({ err, provider: input.provider }, '[PROVIDER-VERIFY] could not report check');
  }
}

export interface ProviderVerificationRow {
  provider: string;
  kind: string;
  catalogVerified: boolean;
  successCount: number;
  failureCount: number;
  /** Distinct stores that settled a real LIVE operation (the evidence that counts). */
  liveStores: number;
  needed: number;
  readyAt: string | null;
  verifiedAt: string | null;
  recent: Array<{
    storeId: string;
    op: string;
    mode: string;
    counted: boolean;
    ok: boolean;
    ref: string | null;
    errorCode: string | null;
    at: string;
  }>;
}

/** Super-admin view: every non-manual catalog provider with its counters and recent evidence. */
export async function listProviderVerification(): Promise<ProviderVerificationRow[]> {
  const codes = PROVIDER_CATALOG.filter(p => !p.manual).map(p => p.code);
  const [rows, events, stores] = await Promise.all([
    prisma.providerVerification.findMany(),
    prisma.providerVerificationEvent.findMany({
      where: { provider: { in: codes } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    prisma.providerVerificationEvent.groupBy({
      by: ['provider', 'sourceStoreId'],
      where: { provider: { in: codes }, counted: true },
    }),
  ]);
  const byCode = new Map(rows.map(r => [r.provider, r]));
  return PROVIDER_CATALOG.filter(p => !p.manual).map(entry => {
    const r = byCode.get(entry.code);
    return {
      provider: entry.code,
      kind: entry.kind,
      catalogVerified: entry.verified,
      successCount: r?.successCount ?? 0,
      failureCount: r?.failureCount ?? 0,
      liveStores: stores.filter(x => x.provider === entry.code).length,
      needed: autoVerifyAfter(),
      readyAt: r?.readyAt ? r.readyAt.toISOString() : null,
      verifiedAt: r?.verifiedAt ? r.verifiedAt.toISOString() : null,
      recent: events
        .filter(e => e.provider === entry.code)
        .slice(0, 10)
        .map(e => ({
          storeId: e.sourceStoreId,
          op: e.op,
          mode: e.mode,
          counted: e.counted,
          ok: e.ok,
          ref: e.ref,
          errorCode: e.errorCode,
          at: e.createdAt.toISOString(),
        })),
    };
  });
}

/**
 * User erasure: the confirming super-admin's id is personal data (classified `merchant-pii`, scrub,
 * subject key userId in packages/cf-schema/erasure-classification.json, like platform_audit_log.actor_id).
 * Null it; the verification itself (verifiedAt) stays, it is platform state. Runs inside the caller's
 * erasure transaction. The Cloudflare twin is `scrubUserFromPlatform` in packages/repo.
 */
export async function scrubProviderVerifier(
  tx: { providerVerification: Pick<typeof prisma.providerVerification, 'updateMany'> },
  userId: string
): Promise<number> {
  const res = await tx.providerVerification.updateMany({
    where: { verifiedById: userId },
    data: { verifiedById: null },
  });
  return res.count;
}
