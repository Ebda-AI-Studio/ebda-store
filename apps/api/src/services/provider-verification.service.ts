/**
 * Ruling PROVIDERS-3: the first merchant's own credentials are a provider's verification.
 *
 * `recordProviderOperation` is called at the real choke points (a payment invoice created or
 * confirmed paid, a shipment booked) and does three things for a provider the catalog does not yet
 * list as verified:
 *   1. appends evidence (store, op, outcome, reference, error CODE; never a credential or a body);
 *   2. pages ops (P1, store scope) on the FIRST real use of the provider by a store, and on every
 *      failed operation while the provider is still unverified (the alert service throttles
 *      repeats), so an integration error is fixed immediately;
 *   3. after PROVIDER_AUTO_VERIFY_AFTER successful operations sets `verified_at`.
 *
 * It NEVER throws and never blocks the money path: bookkeeping failure is logged and swallowed.
 * `isProviderVerified` is BOUNDED-stale (60 s in-process cache): it drives bookkeeping and display
 * only, never an enable or charge gate, so a stale answer has no money consequence.
 */
import { prisma, withStore } from '@ebda/database';
import {
  AUTO_VERIFY_AFTER_DEFAULT,
  PROVIDER_CATALOG,
  getProviderEntry,
  type ProviderKind,
} from '@ebda/shared';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';

export type ProviderOp = 'create_payment' | 'payment_confirmed' | 'create_shipment';

export interface ProviderOperation {
  storeId: string;
  provider: string;
  op: ProviderOp;
  ok: boolean;
  /** Provider-side or Ebda-side reference (invoice id, tracking number). No secret. */
  ref?: string | null;
  /** A short code (error class / provider code); never a raw provider body. */
  errorCode?: string | null;
}

/** Events kept per provider while it is unverified (the evidence is for humans, not analytics). */
const EVENT_CAP = 200;
const CACHE_TTL_MS = 60_000;

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

/** Catalog-verified OR auto-verified from real traffic. */
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

    const prior = await prisma.providerVerificationEvent.findFirst({
      where: { provider: input.provider, sourceStoreId: input.storeId },
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

    if (firstUse || counters.successCount + counters.failureCount <= EVENT_CAP) {
      await prisma.providerVerificationEvent.create({
        data: {
          provider: input.provider,
          sourceStoreId: input.storeId,
          op: input.op,
          ok: input.ok,
          ref: input.ref ?? null,
          errorCode: input.errorCode ?? null,
        },
      });
    }

    if (firstUse || !input.ok) {
      await alertUnverifiedUse(input, entry.kind, firstUse);
    }

    if (input.ok && !counters.verifiedAt && counters.successCount >= autoVerifyAfter()) {
      const flipped = await prisma.providerVerification.updateMany({
        where: { provider: input.provider, verifiedAt: null },
        data: { verifiedAt: new Date() },
      });
      if (flipped.count === 1) {
        verifiedCache = null;
        await sendAlert({
          level: 'info',
          source: 'provider.auto_verified',
          title: `Provider auto-verified: ${input.provider}`,
          body: `${input.provider} reached ${counters.successCount} successful real operations and is now flagged verified. Evidence: provider_verification_events.`,
          context: { provider: input.provider, kind: entry.kind, successes: counters.successCount },
        });
      }
    }
  } catch (err) {
    logger.warn(
      { err, provider: input.provider, storeId: input.storeId, op: input.op },
      '[PROVIDER-VERIFY] could not record provider operation'
    );
  }
}

async function alertUnverifiedUse(
  input: ProviderOperation,
  kind: ProviderKind,
  firstUse: boolean
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
      `${input.provider} (${input.op}) ${outcome} for store ${store.name}. ` +
      'This provider has never been verified against a real account: fix any integration error now.',
    context: {
      provider: input.provider,
      op: input.op,
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
  verifiedAt: string | null;
  needed: number;
  recent: Array<{
    storeId: string;
    op: string;
    ok: boolean;
    ref: string | null;
    errorCode: string | null;
    at: string;
  }>;
}

/** Super-admin view: every non-manual catalog provider with its counters and recent evidence. */
export async function listProviderVerification(): Promise<ProviderVerificationRow[]> {
  const rows = await prisma.providerVerification.findMany();
  const byCode = new Map(rows.map(r => [r.provider, r]));
  const out: ProviderVerificationRow[] = [];
  for (const entry of PROVIDER_CATALOG) {
    if (entry.manual) continue;
    const r = byCode.get(entry.code);
    const events = await prisma.providerVerificationEvent.findMany({
      where: { provider: entry.code },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    out.push({
      provider: entry.code,
      kind: entry.kind,
      catalogVerified: entry.verified,
      successCount: r?.successCount ?? 0,
      failureCount: r?.failureCount ?? 0,
      verifiedAt: r?.verifiedAt ? r.verifiedAt.toISOString() : null,
      needed: autoVerifyAfter(),
      recent: events.map(e => ({
        storeId: e.sourceStoreId,
        op: e.op,
        ok: e.ok,
        ref: e.ref,
        errorCode: e.errorCode,
        at: e.createdAt.toISOString(),
      })),
    });
  }
  return out;
}
