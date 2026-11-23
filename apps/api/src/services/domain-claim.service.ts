/**
 * Custom-domain claims (SP5 task 4, the SP4 tenancy review's squatting gap).
 *
 * A merchant who types `victim.com` has made a CLAIM, not proved ownership. The
 * claim lives in `stores.pending_domain` and is NEVER read by host resolution,
 * credentialed CORS or `storefrontOrigin` (all of which read `stores.domain`
 * with `domain_status = 'active'`). It becomes the store's `domain` only when
 * the provider (Cloudflare for SaaS custom hostname) reports the hostname
 * verified (DCV: the owner controls its DNS).
 *
 *   (none) --claim--> pending --provider verified--> active   (domain := claim)
 *                       |  \--provider gave up--> failed
 *                       \--older than DOMAIN_CLAIM_TTL_HOURS (72h)--> released (none)
 *
 * - A domain ACTIVE on another store can never be claimed.
 * - A fresh PENDING claim by another store blocks (DOMAIN_TAKEN); a stale one
 *   (> TTL) is released on the spot, so a squatter cannot hold a name forever.
 * - The sweep (Inngest, hourly) verifies pending claims and releases the
 *   stale ones, removing the hostname from the provider so the real owner can
 *   attach it.
 *
 * `stores` has RLS disabled (Ruling FRT-3), so these reads/writes need no tenant
 * context and stay in the existing plain-prisma style.
 */
import { prisma, Prisma, storeDirectory, withStore } from '@ebda/database';
import { storeIdByDomain, storeIdsClaimingDomain } from '../lib/definer';
import { abuseConfig } from '../lib/abuse-config';
import { bustCorsCache } from '../lib/cors-cache';
import { invalidateCached } from '../lib/public-cache';
import logger from '../lib/logger';
import { AppError } from '../middleware/error-handler';
import { redis } from './redis.service';
import type { DomainProvider } from './domain-provider';
import { bustStoreCaches } from './store.service';
import { storeUpdate, storeUpdateMany } from '../lib/repo-factory';

export type DomainClaimState = 'pending' | 'active' | 'failed';

const HOUR_MS = 60 * 60 * 1000;
export const claimTtlMs = () => abuseConfig.domainClaimTtlHours() * HOUR_MS;

/** Lowercase, trimmed, `www.` stripped (domains are stored apex-normalised). */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.+$/, '');
}

const claimSelect = {
  id: true,
  slug: true,
  domain: true,
  domainStatus: true,
  pendingDomain: true,
  domainClaimedAt: true,
} satisfies Prisma.StoreSelect;

/** True when the pending claim is older than the TTL (or has no timestamp). */
export function isClaimStale(claimedAt: Date | null, now: Date = new Date()): boolean {
  return !claimedAt || now.getTime() - claimedAt.getTime() > claimTtlMs();
}

/** Remove a hostname from the provider; never throws (a stranded alias is only housekeeping). */
async function removeFromProvider(provider: DomainProvider, domain: string): Promise<void> {
  try {
    await provider.removeDomain(domain);
  } catch (err) {
    logger.error({ err, domain }, '[DOMAIN CLAIM] provider removal failed — manual cleanup needed');
  }
}

export class DomainClaimService {
  /**
   * Claim `domain` for a store. Returns the claim state: `pending` for a new
   * claim (the normal answer), `active` when the store already owns the domain.
   * Throws DOMAIN_TAKEN (400) / DOMAIN_PROVISION_FAILED (502).
   */
  static async claim(
    storeId: string,
    rawDomain: string,
    provider: DomainProvider,
    now: Date = new Date()
  ): Promise<{ state: DomainClaimState; domain: string }> {
    const domain = normalizeDomain(rawDomain);
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: claimSelect })
    );
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');

    // Already the store's verified domain: just drop any other pending claim.
    if (store.domain === domain && store.domainStatus === 'active') {
      if (store.pendingDomain) await this.cancelPending(storeId, provider);
      return { state: 'active', domain };
    }

    // Re-submitting the same pending claim: a failed one is retried afresh.
    if (store.pendingDomain === domain && store.domainStatus === 'pending') {
      return { state: 'pending', domain };
    }

    // A domain ACTIVE on another store is never claimable.
    // `stores` is under RLS (R-EBDA-005): other stores are probed through definers.
    const activeOwner = await storeIdByDomain(domain);
    if (activeOwner && activeOwner !== storeId) {
      throw new AppError(400, 'DOMAIN_TAKEN', 'Domain is already in use by another store');
    }

    // Another store's PENDING claim blocks while fresh; a stale one is released.
    const claimants = (await storeIdsClaimingDomain(domain)).filter(id => id !== storeId);
    const pendingElsewhere = (
      await Promise.all(
        claimants.map(id =>
          withStore(id, tx => tx.store.findUnique({ where: { id }, select: claimSelect }))
        )
      )
    ).filter((r): r is NonNullable<typeof r> => r !== null);
    for (const other of pendingElsewhere) {
      if (!isClaimStale(other.domainClaimedAt, now)) {
        throw new AppError(400, 'DOMAIN_TAKEN', 'Domain is already in use by another store');
      }
      await this.release(other.id, provider);
    }

    // Retrying a FAILED claim of the same name: clear the dead hostname first.
    if (store.pendingDomain === domain) await removeFromProvider(provider, domain);

    // Provider FIRST (an add that fails must not leave a row claiming it).
    const added = await provider.addDomain(domain);
    if (!added) {
      throw new AppError(
        502,
        'DOMAIN_PROVISION_FAILED',
        'Failed to register domain with the platform. Please try again or contact support.'
      );
    }

    const previousPending = store.pendingDomain;
    try {
      await withStore(storeId, tx =>
        storeUpdate(tx, {
          where: { id: storeId },
          data: { pendingDomain: domain, domainStatus: 'pending', domainClaimedAt: now },
        })
      );
    } catch (err) {
      // The provider holds a hostname no row references: take it back.
      await removeFromProvider(provider, domain);
      throw err;
    }

    // Superseded pending claim of THIS store: free its hostname.
    if (previousPending && previousPending !== domain) {
      await removeFromProvider(provider, previousPending);
    }
    return { state: 'pending', domain };
  }

  /** Drop this store's unverified claim (the merchant changed their mind). */
  static async cancelPending(storeId: string, provider: DomainProvider): Promise<void> {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: claimSelect })
    );
    if (!store?.pendingDomain) return;
    await withStore(storeId, tx =>
      storeUpdateMany(tx, {
        where: { id: storeId, pendingDomain: store.pendingDomain },
        data: {
          pendingDomain: null,
          domainClaimedAt: null,
          domainStatus: store.domain ? 'active' : null,
        },
      })
    );
    await removeFromProvider(provider, store.pendingDomain);
  }

  /**
   * Release a pending/failed claim (stale, or displaced by a verified owner):
   * clear the row, free the hostname at the provider. Idempotent.
   */
  static async release(
    storeId: string,
    provider: DomainProvider
  ): Promise<{ released: string | null }> {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: claimSelect })
    );
    const pending = store?.pendingDomain ?? null;
    if (!store || !pending) return { released: null };
    const res = await withStore(storeId, tx =>
      storeUpdateMany(tx, {
        where: { id: storeId, pendingDomain: pending },
        data: {
          pendingDomain: null,
          domainClaimedAt: null,
          domainStatus: store.domain ? 'active' : null,
        },
      })
    );
    if (res.count === 0) return { released: null }; // lost a race with activate/release
    // Never tear down a hostname another store has since verified.
    const owner = await storeIdByDomain(pending);
    if (!owner) await removeFromProvider(provider, pending);
    logger.info({ storeId, domain: pending }, '[DOMAIN CLAIM] released');
    return { released: pending };
  }

  /**
   * Re-check one store's pending claim against the provider. Promotes it to
   * the store's `domain` when verified, marks it `failed` when the provider
   * gave up, releases it when stale. Safe to call from a request (the admin
   * status poll) and from the sweep.
   */
  static async sync(
    storeId: string,
    provider: DomainProvider,
    now: Date = new Date()
  ): Promise<{ action: 'none' | 'activated' | 'failed' | 'released' | 'pending' }> {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: claimSelect })
    );
    const pending = store?.pendingDomain;
    if (store && !pending && store.domain && store.domainStatus !== 'active') {
      // STORE-QA-40: a store that holds a `domain` but whose status never reached 'active' (a claim promoted by hand, a drifted
      // row) was invisible to this reconcile: the sweep only looked at `pendingDomain`, so the admin said "awaiting verification"
      // for a hostname that already served the storefront. Probe the provider; a verified hostname becomes 'active'.
      let status: Awaited<ReturnType<DomainProvider['getDomain']>> = null;
      try {
        status = await provider.getDomain(store.domain);
      } catch (err) {
        logger.warn(
          { err, storeId, domain: store.domain },
          '[DOMAIN CLAIM] provider status failed'
        );
      }
      if (!status?.verified) return { action: 'none' };
      const domain = store.domain;
      const res = await withStore(storeId, tx =>
        storeUpdateMany(tx, {
          where: { id: storeId, domain },
          data: { domainStatus: 'active', domainVerifiedAt: now, domainClaimedAt: null },
        })
      );
      if (res.count === 0) return { action: 'none' };
      await this.afterDomainChanged({
        storeId,
        slug: store.slug,
        oldDomain: domain,
        newDomain: domain,
        provider,
      });
      return { action: 'activated' };
    }
    if (!store || !pending) return { action: 'none' };

    let verifiedStatus: Awaited<ReturnType<DomainProvider['getDomain']>> = null;
    try {
      verifiedStatus = await provider.getDomain(pending);
    } catch (err) {
      logger.warn({ err, storeId, domain: pending }, '[DOMAIN CLAIM] provider status failed');
    }

    // Verified wins over stale: a claim verified on the last tick of its TTL is real.
    if (verifiedStatus?.verified) {
      return (await this.activate(storeId, pending, provider))
        ? { action: 'activated' }
        : { action: 'failed' };
    }
    if (isClaimStale(store.domainClaimedAt, now)) {
      await this.release(storeId, provider);
      return { action: 'released' };
    }
    if (verifiedStatus?.failed && store.domainStatus !== 'failed') {
      await withStore(storeId, tx =>
        storeUpdateMany(tx, {
          where: { id: storeId, pendingDomain: pending },
          data: { domainStatus: 'failed' },
        })
      );
      return { action: 'failed' };
    }
    return { action: 'pending' };
  }

  /**
   * Promote a verified claim: `domain := pendingDomain`, status `active`, then
   * the post-change side effects (caches, CORS, Resend sender, old-domain
   * teardown). Returns false when the name was taken by another store in the
   * meantime (the unique index): the claim is marked failed.
   */
  static async activate(
    storeId: string,
    pending: string,
    provider: DomainProvider,
    now: Date = new Date()
  ): Promise<boolean> {
    const before = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: claimSelect })
    );
    if (!before || before.pendingDomain !== pending) return false;
    const oldDomain = before.domain;
    try {
      const res = await withStore(storeId, tx =>
        storeUpdateMany(tx, {
          where: { id: storeId, pendingDomain: pending },
          data: {
            domain: pending,
            domainStatus: 'active',
            domainVerifiedAt: now,
            pendingDomain: null,
            domainClaimedAt: null,
          },
        })
      );
      if (res.count === 0) return false;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        await withStore(storeId, tx =>
          storeUpdateMany(tx, {
            where: { id: storeId, pendingDomain: pending },
            data: { domainStatus: 'failed' },
          })
        );
        return false;
      }
      throw err;
    }
    logger.info({ storeId, domain: pending, oldDomain }, '[DOMAIN CLAIM] activated');
    await this.afterDomainChanged({
      storeId,
      slug: before.slug,
      oldDomain,
      newDomain: pending,
      provider,
    });
    return true;
  }

  /**
   * Everything that must follow a change of the store's verified domain (also
   * used when a store REMOVES its domain, with `newDomain: null`): the stored
   * llms.txt carries absolute URLs, the Resend sender follows the domain, the
   * superseded hostname leaves the provider, and every cache keyed by either
   * host is busted so the resolver and CORS see the change immediately.
   */
  static async afterDomainChanged(input: {
    storeId: string;
    slug: string;
    oldDomain: string | null;
    newDomain: string | null;
    provider: DomainProvider;
  }): Promise<void> {
    const { storeId, slug, oldDomain, newDomain, provider } = input;
    if (oldDomain === newDomain) return;

    await withStore(storeId, tx =>
      storeUpdate(tx, { where: { id: storeId }, data: { llmsTxt: null } })
    ).catch(err => logger.warn({ err, storeId }, '[DOMAIN CLAIM] failed to clear stale llms.txt'));

    // Old hostname leaves the provider only AFTER the DB points at the new one.
    if (oldDomain) {
      void removeFromProvider(provider, oldDomain);
      bustCorsCache(oldDomain);
      void invalidateCached(`public:store:resolve:${oldDomain}`);
      void redis.delete(`store:domain:${oldDomain}`).catch(() => undefined);
    }
    if (newDomain) {
      bustCorsCache(newDomain);
      void invalidateCached(`public:store:resolve:${newDomain}`);
    }
    await bustStoreCaches(storeId, slug, newDomain, { domain: oldDomain });
  }

  /**
   * One pass: verify every fresh pending claim, then release every stale one.
   * Bounded per run; the next tick takes the rest. Returns counts for the log.
   */
  static async sweep(
    provider: DomainProvider,
    now: Date = new Date(),
    limit = 200
  ): Promise<{ examined: number; activated: number; failed: number; released: number }> {
    // `stores` is under RLS (R-EBDA-005): the cron lists claimants through the store
    // directory (id order; the per-store `sync` reads each claim in its own scope).
    // Pending claims FIRST (they are the work), then stores that merely hold a domain (a stuck-short-of-active one is reconciled;
    // an active one is a cheap no-op read). The directory summary carries no domain status, so the holders are taken from a
    // window that ROTATES each run: pending claims can never be starved by active domains, and every holder is reached over time.
    const all = await storeDirectory(s => s.hasPendingDomain || s.hasDomain);
    const pendingRows = all.filter(s => s.hasPendingDomain).slice(0, limit);
    const holders = all.filter(s => !s.hasPendingDomain && s.hasDomain);
    const room = Math.max(0, limit - pendingRows.length);
    const start =
      holders.length > 0 ? (Math.floor(now.getTime() / HOUR_MS) * room) % holders.length : 0;
    const rotated = [...holders.slice(start), ...holders.slice(0, start)].slice(0, room);
    const rows = [...pendingRows, ...rotated];
    const out = { examined: rows.length, activated: 0, failed: 0, released: 0 };
    for (const { id } of rows) {
      try {
        const r = await this.sync(id, provider, now);
        if (r.action === 'activated') out.activated++;
        else if (r.action === 'failed') out.failed++;
        else if (r.action === 'released') out.released++;
      } catch (err) {
        logger.error({ err, storeId: id }, '[DOMAIN CLAIM] sweep step failed');
      }
    }
    return out;
  }
}
