/**
 * SP5 task 4 - custom-domain squatting, against a real Postgres.
 *
 * A custom domain is a CLAIM until the provider (Cloudflare for SaaS) reports
 * it verified. Asserted end to end through the real routes + resolver:
 *
 *   claim -> PENDING: not resolvable (public resolve 404), not CORS-trusted,
 *            not in storefrontOrigin
 *   provider verified -> ACTIVE: resolvable immediately (status poll or sweep)
 *   pending older than 72h -> RELEASED by the sweep (hostname freed at the
 *            provider; the real owner can then claim it)
 *   a domain ACTIVE on another store can never be claimed
 *
 * Mutation proofs (recorded in the commit body):
 *   1. lib/store-host.ts `storeDomainWhere`: drop `domainStatus: 'active'` and
 *      write the pending claim into `domain` -> the pending-not-resolvable
 *      cases fail (resolver serves an unverified domain).
 *   2. services/domain-claim.service.ts `isClaimStale`: `>` -> `<` (or a 7-day
 *      TTL) -> "released after 72h" fails.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@ebda/database';
import { storefrontOrigin } from '@ebda/shared';
import { config } from '@api/config';
import type { DomainProvider, DomainStatus } from '@api/services/domain-provider';
import { hasDb } from '../helpers/bundle-fixtures';

/** In-memory Cloudflare: hostnames the platform registered and what DCV says about them. */
const cf = vi.hoisted(() => {
  const hosts = new Map<string, { verified: boolean; failed: boolean }>();
  return { hosts };
});
vi.mock('@api/services/domain-provider', () => {
  const provider = {
    providerName: 'cloudflare' as const,
    isConfigured: () => true,
    addDomain: async (d: string) => {
      if (cf.hosts.has(d)) return null; // hostname already enrolled (duplicate)
      cf.hosts.set(d, { verified: false, failed: false });
      return { id: d };
    },
    removeDomain: async (d: string) => cf.hosts.delete(d),
    getDomain: async (d: string): Promise<DomainStatus | null> => {
      const h = cf.hosts.get(d);
      if (!h) return null;
      return {
        domain: d,
        verified: h.verified,
        failed: h.failed,
        misconfigured: !h.verified,
        dnsRecords: [{ type: 'CNAME', name: d, value: 'cf.ebda.app' }],
      };
    },
  } satisfies DomainProvider;
  return {
    resolveDomainService: () => provider,
    getDomainProviderName: () => 'cloudflare' as const,
  };
});
vi.mock('@api/services/resend.service', () => ({
  ResendService: {
    removeStoreDomain: vi.fn().mockResolvedValue(undefined),
    provisionStoreDomain: vi.fn().mockResolvedValue([]),
    refreshDomainStatus: vi.fn(),
  },
}));

import storeRoutes from '@api/routes/store.routes';
import publicRoutes from '@api/routes/public.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { corsStoreOriginWhere } from '@api/lib/cors-cache';
import { DomainClaimService, claimTtlMs } from '@api/services/domain-claim.service';
import { resolveDomainService } from '@api/services/domain-provider';
import { planService } from '@api/services/plan.service';
import { redis } from '@api/services/redis.service';

const run = crypto.randomUUID().slice(0, 8);
const HOUR = 3600_000;
const storeIds: string[] = [];
const userIds: string[] = [];
const dom = (tag: string) => `${tag}-${run}.example.com`;

function tokenFor(userId: string) {
  return jwt.sign(
    { userId, email: `${userId}@example.test`, role: 'store_admin', tv: 0 },
    config.jwtSecret,
    {
      expiresIn: '30m',
      issuer: 'ebda-api',
      audience: 'ebda-app',
    }
  );
}

async function mkStore(tag: string) {
  const user = await prisma.user.create({
    data: {
      email: `dom-${tag}-${run}@test.local`,
      passwordHash: 'x',
      firstName: 'Dom',
      lastName: tag,
      role: 'store_admin',
      emailVerified: true,
    },
  });
  const store = await prisma.store.create({
    data: {
      name: `dom-${tag}-${run}`,
      slug: `dom-${tag}-${run}`,
      ownerId: user.id,
      status: 'active',
    },
  });
  await planService.assignPlan(store.id, { planCode: 'comped' });
  userIds.push(user.id);
  storeIds.push(store.id);
  return { id: store.id, jwt: tokenFor(user.id), slug: store.slug };
}

describe.skipIf(!hasDb)('custom-domain claims', () => {
  let app: Express;
  const auth = (j: string) => ({ Authorization: `Bearer ${j}` });
  const claim = (s: { id: string; jwt: string }, domain: string | null) =>
    request(app).put(`/api/v1/stores/${s.id}/domain`).set(auth(s.jwt)).send({ domain });
  const poll = (s: { id: string; jwt: string }) =>
    request(app).get(`/api/v1/stores/${s.id}/domain`).set(auth(s.jwt));
  const resolve = (host: string) =>
    request(app).get('/api/v1/public/store/resolve').set('x-store-domain', host);
  const row = (id: string) =>
    prisma.store.findUniqueOrThrow({
      where: { id },
      select: {
        domain: true,
        pendingDomain: true,
        domainStatus: true,
        domainClaimedAt: true,
        domainVerifiedAt: true,
      },
    });
  const verifyAtProvider = (d: string) => (cf.hosts.get(d)!.verified = true);
  const backdate = (id: string, hours: number) =>
    prisma.store.update({
      where: { id },
      data: { domainClaimedAt: new Date(Date.now() - hours * HOUR) },
    });

  beforeAll(async () => {
    await redis.connect();
    app = express();
    app.use(express.json());
    app.use('/api/v1/stores', storeRoutes);
    app.use('/api/v1/public', publicRoutes);
    app.use(errorHandler);
  });
  afterAll(async () => {
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await redis.disconnect();
  });

  it('a new claim is PENDING: stored apart from `domain`, not resolvable, not CORS-trusted', async () => {
    const s = await mkStore('pend');
    const d = dom('pend');
    const res = await claim(s, d);
    expect(res.status).toBe(200);
    expect(res.body.data.claim).toEqual({ state: 'pending', domain: d });

    expect(await row(s.id)).toMatchObject({
      domain: null,
      pendingDomain: d,
      domainStatus: 'pending',
    });
    // Not resolvable: the storefront resolver answers 404 for it.
    expect((await resolve(d)).status).toBe(404);
    expect((await resolve(`www.${d}`)).status).toBe(404);
    // Not CORS-trusted: the credentialed-CORS lookup requires an ACTIVE domain.
    const cors = corsStoreOriginWhere(d)!;
    expect(await prisma.store.findFirst({ where: cors.where })).toBeNull();
    // Not in storefrontOrigin: the store still answers on its free address.
    const r = await row(s.id);
    expect(storefrontOrigin({ slug: s.slug, domain: r.domain })).toContain(s.slug);
    expect(storefrontOrigin({ slug: s.slug, domain: r.domain })).not.toContain(d);
    // …and it is registered with the provider, awaiting DCV.
    expect(cf.hosts.get(d)).toEqual({ verified: false, failed: false });
  });

  it('becomes resolvable the moment the provider reports it verified (status poll)', async () => {
    const s = await mkStore('verify');
    const d = dom('verify');
    await claim(s, d);
    expect((await resolve(d)).status).toBe(404);

    // Still unverified: polling changes nothing.
    const still = await poll(s);
    expect(still.status).toBe(200);
    expect(still.body.data.claimStatus).toBe('pending');
    expect((await resolve(d)).status).toBe(404);

    verifyAtProvider(d);
    const after = await poll(s);
    expect(after.body.data.claimStatus).toBe('active');
    expect(await row(s.id)).toMatchObject({
      domain: d,
      pendingDomain: null,
      domainStatus: 'active',
    });
    expect((await row(s.id)).domainVerifiedAt).not.toBeNull();

    const live = await resolve(d);
    expect(live.status).toBe(200);
    expect(live.body.data.id ?? live.body.data.store?.id).toBe(s.id);
    expect((await resolve(`www.${d}`)).status).toBe(200);
    const cors = corsStoreOriginWhere(d)!;
    expect((await prisma.store.findFirst({ where: cors.where }))?.id).toBe(s.id);
  });

  it('the sweep promotes a verified claim without anyone polling', async () => {
    const s = await mkStore('sweepok');
    const d = dom('sweepok');
    await claim(s, d);
    verifyAtProvider(d);
    const out = await DomainClaimService.sweep(resolveDomainService());
    expect(out.activated).toBeGreaterThanOrEqual(1);
    expect((await row(s.id)).domain).toBe(d);
    expect((await resolve(d)).status).toBe(200);
  });

  it('an unverified claim is RELEASED after 72h so it cannot block the real owner', async () => {
    const squatter = await mkStore('sq');
    const owner = await mkStore('real');
    const d = dom('victim');
    expect((await claim(squatter, d)).status).toBe(200);

    // Within the TTL the squatter's claim holds the name...
    await backdate(squatter.id, 71);
    const blocked = await claim(owner, d);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('DOMAIN_TAKEN');
    await DomainClaimService.sweep(resolveDomainService());
    expect((await row(squatter.id)).pendingDomain).toBe(d);

    // ...past 72h the sweep releases it (and frees the hostname at the provider).
    await backdate(squatter.id, 73);
    const out = await DomainClaimService.sweep(resolveDomainService());
    expect(out.released).toBeGreaterThanOrEqual(1);
    expect(await row(squatter.id)).toMatchObject({
      domain: null,
      pendingDomain: null,
      domainStatus: null,
      domainClaimedAt: null,
    });
    expect(cf.hosts.has(d)).toBe(false);
    expect((await resolve(d)).status).toBe(404);

    // The real owner can now claim and verify it.
    expect((await claim(owner, d)).status).toBe(200);
    verifyAtProvider(d);
    await poll(owner);
    expect((await resolve(d)).status).toBe(200);
    expect((await row(owner.id)).domain).toBe(d);
  });

  it('a stale pending claim is released on the spot when another store claims the name', async () => {
    const squatter = await mkStore('sq2');
    const owner = await mkStore('real2');
    const d = dom('victim2');
    await claim(squatter, d);
    await backdate(squatter.id, 80);
    const res = await claim(owner, d);
    expect(res.status).toBe(200);
    expect((await row(squatter.id)).pendingDomain).toBeNull();
    expect((await row(owner.id)).pendingDomain).toBe(d);
  });

  it('a claim verified after the TTL is still honoured (verified wins over stale)', async () => {
    const s = await mkStore('late');
    const d = dom('late');
    await claim(s, d);
    await backdate(s.id, 100);
    verifyAtProvider(d);
    await DomainClaimService.sweep(resolveDomainService());
    expect((await row(s.id)).domain).toBe(d);
  });

  it('a domain ACTIVE on another store can never be claimed', async () => {
    const a = await mkStore('act-a');
    const b = await mkStore('act-b');
    const d = dom('taken');
    await claim(a, d);
    verifyAtProvider(d);
    await poll(a);
    expect((await row(a.id)).domain).toBe(d);

    const res = await claim(b, d);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DOMAIN_TAKEN');
    expect((await row(b.id)).pendingDomain).toBeNull();
    // A stale-looking active domain is never released by the sweep.
    await DomainClaimService.sweep(resolveDomainService());
    expect((await row(a.id)).domain).toBe(d);
    expect((await resolve(d)).status).toBe(200);
  });

  it('a failed claim (provider gave up) is surfaced, never served, and released with the TTL', async () => {
    const s = await mkStore('fail');
    const d = dom('fail');
    await claim(s, d);
    cf.hosts.get(d)!.failed = true;
    const out = await DomainClaimService.sweep(resolveDomainService());
    expect(out.failed).toBeGreaterThanOrEqual(1);
    expect(await row(s.id)).toMatchObject({
      domain: null,
      pendingDomain: d,
      domainStatus: 'failed',
    });
    expect((await poll(s)).body.data.claimStatus).toBe('failed');
    expect((await resolve(d)).status).toBe(404);
    await backdate(s.id, 73);
    await DomainClaimService.sweep(resolveDomainService());
    expect((await row(s.id)).pendingDomain).toBeNull();
  });

  it('replacing an active domain keeps the OLD one serving until the new one verifies', async () => {
    const s = await mkStore('swap');
    const oldD = dom('old');
    const newD = dom('new');
    await claim(s, oldD);
    verifyAtProvider(oldD);
    await poll(s);
    expect((await resolve(oldD)).status).toBe(200);

    expect((await claim(s, newD)).status).toBe(200);
    expect(await row(s.id)).toMatchObject({ domain: oldD, pendingDomain: newD });
    expect((await resolve(oldD)).status).toBe(200); // still serving
    expect((await resolve(newD)).status).toBe(404); // not yet

    verifyAtProvider(newD);
    await poll(s);
    expect(await row(s.id)).toMatchObject({
      domain: newD,
      pendingDomain: null,
      domainStatus: 'active',
    });
    expect((await resolve(newD)).status).toBe(200);
    expect((await resolve(oldD)).status).toBe(404);
    expect(cf.hosts.has(oldD)).toBe(false); // torn down at the provider
  });

  it('removing a domain clears the active domain and any pending claim', async () => {
    const s = await mkStore('clear');
    const d = dom('clear');
    await claim(s, d);
    verifyAtProvider(d);
    await poll(s);
    expect((await claim(s, null)).status).toBe(200);
    expect(await row(s.id)).toMatchObject({
      domain: null,
      pendingDomain: null,
      domainStatus: null,
    });
    expect((await resolve(d)).status).toBe(404);
  });

  it('the generic store update cannot set a domain (no bypass around the claim flow)', async () => {
    const s = await mkStore('bypass');
    const d = dom('bypass');
    const res = await request(app)
      .put(`/api/v1/stores/${s.id}`)
      .set(auth(s.jwt))
      .send({ name: 'Renamed', domain: d });
    expect(res.status).toBe(200);
    expect(await row(s.id)).toMatchObject({ domain: null, pendingDomain: null });
    expect((await resolve(d)).status).toBe(404);
  });

  it('rejects Ebda-owned and malformed hosts as DOMAIN_INVALID', async () => {
    const s = await mkStore('inv');
    for (const bad of ['somebody.ebda.app', 'localhost', '10.0.0.1']) {
      const res = await claim(s, bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DOMAIN_INVALID');
    }
  });

  it('the TTL is 72h by default and configurable', () => {
    expect(claimTtlMs()).toBe(72 * HOUR);
    process.env.DOMAIN_CLAIM_TTL_HOURS = '24';
    expect(claimTtlMs()).toBe(24 * HOUR);
    delete process.env.DOMAIN_CLAIM_TTL_HOURS;
  });
});
