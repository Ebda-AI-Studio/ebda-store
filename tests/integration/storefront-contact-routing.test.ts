/**
 * Storefront POST /public/contact names the store the shopper wrote on (Ruling FU46-1), runs as
 * production does (guarded ebda_app client per request), refuses a demo store and drops a
 * honeypot submission silently.
 *
 * The recipient cases (store email, else the owner's account; suspended owner; platform address) moved to
 * tests/unit/store-contact-target-on-do.test.ts when `storeContactTarget` moved to storeDb + the identity service.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { withRlsBypass, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { CONTACT_HONEYPOT_FIELD } from '@ebda/shared';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import publicRoutes from '@api/routes/public.routes';
import { publicStoreContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { inngest } from '@api/lib/inngest/client';
import { redis } from '@api/services/redis.service';
import { hasDb, seedStoreWithoutBundlesFeature } from '../helpers/bundle-fixtures';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, res: Response, next: NextFunction) => {
    asApp(
      () =>
        new Promise<void>(resolve => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        })
    ).catch(next);
  });
  // Mounted exactly as apps/api/src/routes/index.ts mounts it.
  app.use('/api/v1/public', publicStoreContext);
  app.use('/api/v1/public', publicRoutes);
  app.use(errorHandler);
  return app;
}

const run = crypto.randomUUID().slice(0, 8);
const MESSAGE = {
  name: 'Mona',
  email: 'mona@example.test',
  subject: 'Size question',
  message: 'Do you have it in M?',
};

describe.skipIf(!hasDb)('storefront contact routing (FU46-1)', () => {
  let app: Express;
  let shop: { storeId: string; ownerId: string };
  let demo: { storeId: string; ownerId: string };
  let capped: { storeId: string; ownerId: string };
  let other: { storeId: string; ownerId: string };
  let send: ReturnType<typeof vi.spyOn<typeof inngest, 'send'>>;

  beforeAll(async () => {
    app = buildApp();
    await redis.connect();
    shop = await seedStoreWithoutBundlesFeature(`contact-${run}-shop`);
    demo = await seedStoreWithoutBundlesFeature(`contact-${run}-demo`);
    capped = await seedStoreWithoutBundlesFeature(`contact-${run}-capped`);
    other = await seedStoreWithoutBundlesFeature(`contact-${run}-other`);
    await withRlsBypass(async tx => {
      await tx.store.update({ where: { id: shop.storeId }, data: { email: 'shop@example.test' } });
      await tx.store.update({ where: { id: demo.storeId }, data: { isDemo: true } });
    });
  });

  beforeEach(async () => {
    // The per-IP writeLimiter (30/min) shares this private test Redis: reset it so the 21-message
    // cap test is not starved by earlier requests from the same supertest IP.
    await redis.getConnectedClient().flushdb();
    // Re-install the spy per test: inngest.send is swapped once the real client has run.
    vi.restoreAllMocks();
    send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: ['evt'] } as never);
  });

  const post = (storeId: string | null, body: Record<string, unknown>) => {
    const r = request(app).post('/api/v1/public/contact');
    return (storeId ? r.set('X-Store-ID', storeId) : r).send(body);
  };

  it('enqueues the message for the store it was written on', async () => {
    const res = await post(shop.storeId, MESSAGE);
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      name: 'contact/form.submitted',
      data: { storeId: shop.storeId, ...MESSAGE },
    });
  });

  it('refuses a message that names no store', async () => {
    const res = await post(null, MESSAGE);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('STORE_NOT_RESOLVED');
    expect(send).not.toHaveBeenCalled();
  });

  it('a demo store refuses, in both languages', async () => {
    const res = await post(demo.storeId, MESSAGE);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEMO_STORE');
    expect(res.body.error.details.messageAr).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('a filled honeypot answers success and sends nothing', async () => {
    const res = await post(shop.storeId, { ...MESSAGE, [CONTACT_HONEYPOT_FIELD]: 'http://spam' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('honeypot of any length is a silent success, never a 400', async () => {
    const res = await post(shop.storeId, {
      ...MESSAGE,
      [CONTACT_HONEYPOT_FIELD]: 'x'.repeat(5000),
    });
    expect(res.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it('X-Store-ID wins over a conflicting x-store-domain, and a body storeId is ignored', async () => {
    const res = await request(app)
      .post('/api/v1/public/contact')
      .set('X-Store-ID', shop.storeId)
      .set('x-store-domain', `bundle-fixture-nofeature-contact-${run}-other.ebda.app`)
      .send({ ...MESSAGE, storeId: other.storeId });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({
      name: 'contact/form.submitted',
      data: { storeId: shop.storeId, ...MESSAGE },
    });
  });

  it('per-store cap: the 21st message in the window is dropped silently; another store is unaffected', async () => {
    for (let i = 0; i < 20; i++) expect((await post(capped.storeId, MESSAGE)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(20);
    const over = await post(capped.storeId, MESSAGE);
    expect(over.status).toBe(200);
    expect(over.body.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(20);
    expect((await post(other.storeId, MESSAGE)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(21);
    expect(send).toHaveBeenLastCalledWith({
      name: 'contact/form.submitted',
      data: { storeId: other.storeId, ...MESSAGE },
    });
  });

  it('the cap window is FIXED: over-cap hits never extend the TTL, and the count resets after it', async () => {
    const raw = (
      redis as unknown as {
        getConnectedClient(): {
          ttl(k: string): Promise<number>;
          expire(k: string, s: number): Promise<number>;
          del(k: string): Promise<number>;
        };
      }
    ).getConnectedClient();
    const key = `ratelimit:contact:${capped.storeId}`;
    await raw.del(key);
    for (let i = 0; i < 20; i++) await post(capped.storeId, MESSAGE);
    await raw.expire(key, 100); // simulate time passing: 100s left of the window
    for (let i = 0; i < 3; i++) await post(capped.storeId, MESSAGE); // dropped hits
    const ttl = await raw.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100); // not re-armed to 3600
    expect(send).toHaveBeenCalledTimes(20);
    await raw.del(key); // the window elapsed
    await post(capped.storeId, MESSAGE);
    expect(send).toHaveBeenCalledTimes(21);
    expect(await raw.ttl(key)).toBeGreaterThan(3000); // a fresh window
  });
});
