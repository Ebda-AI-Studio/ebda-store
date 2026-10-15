/**
 * Storefront POST /public/contact names the store the shopper wrote on (Ruling FU46-1), runs as
 * production does (guarded ebda_app client per request), refuses a demo store and drops a
 * honeypot submission silently.
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
import { storeContactTarget } from '@api/services/store-contact.service';
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
  let noEmail: { storeId: string; ownerId: string };
  let demo: { storeId: string; ownerId: string };
  const send = vi.spyOn(inngest, 'send');

  beforeAll(async () => {
    app = buildApp();
    shop = await seedStoreWithoutBundlesFeature(`contact-${run}-shop`);
    noEmail = await seedStoreWithoutBundlesFeature(`contact-${run}-noemail`);
    demo = await seedStoreWithoutBundlesFeature(`contact-${run}-demo`);
    await withRlsBypass(async tx => {
      await tx.store.update({ where: { id: shop.storeId }, data: { email: 'shop@example.test' } });
      await tx.store.update({ where: { id: noEmail.storeId }, data: { email: null } });
      await tx.store.update({ where: { id: demo.storeId }, data: { isDemo: true } });
    });
  });

  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({ ids: ['evt'] } as never);
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

  it("recipient: the store's contact email, else the owner's account email (as ebda_app)", async () => {
    expect(await asApp(() => storeContactTarget(shop.storeId))).toMatchObject({
      to: 'shop@example.test',
      isDemo: false,
    });
    expect(await asApp(() => storeContactTarget(noEmail.storeId))).toMatchObject({
      to: `bundle-fixture-nofeature-owner-contact-${run}-noemail@example.com`,
    });
    expect(await asApp(() => storeContactTarget(demo.storeId))).toMatchObject({ isDemo: true });
  });
});
