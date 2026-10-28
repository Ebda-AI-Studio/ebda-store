/**
 * Payload PARITY for GET /public/store/resolve (the host -> store payload every storefront page
 * depends on). The fill makes many small reads; this file pins the exact JSON it returns for a
 * fixture store with every optional block populated (disabled CMS pages, FAQs, HowTos, locations
 * with the footer opt-in, tax profile, SMS/cart-email availability) and for a bare store, so a
 * refactor of HOW those reads are made cannot change WHAT is returned.
 *
 * The golden files are produced by the pre-refactor code (UPDATE_GOLDEN=1) and compared
 * byte-for-byte (after replacing run-specific ids and timestamps by stable placeholders).
 * Run on a real `ebda_app` login, like production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import publicRoutes from '@api/routes/public.routes';
import { publicStoreContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { hasDb } from '../helpers/bundle-fixtures';
import { setAppRoleLogin } from '../helpers/app-role-login';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const PREFIX = 'rspar-';
const GOLDEN = path.join(__dirname, '__golden__');
const appUrl = () => {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
};

/** Stable placeholders for ids / timestamps / the run suffix, preserving structure and order. */
export function normalize(value: unknown, run: string): unknown {
  const seen = new Map<string, string>();
  const stable = (s: string, kind: string) => {
    if (!seen.has(s)) seen.set(s, `<${kind}-${seen.size + 1}>`);
    return seen.get(s)!;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
        return stable(v, 'uuid');
      if (/^c[a-z0-9]{24}$/.test(v)) return stable(v, 'cuid');
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) return '<ts>';
      return v.split(run).join('<run>');
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

describe.skipIf(!hasDb)('GET /public/store/resolve payload parity (ebda_app)', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const run = crypto.randomUUID().slice(0, 8);
  const slugs = { full: `${PREFIX}full-${run}`, bare: `${PREFIX}bare-${run}` };

  async function cleanup() {
    const where = `store_id IN (SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`;
    for (const t of [
      'store_faqs',
      'store_howtos',
      'store_pages',
      'store_locations',
      'store_tax_profiles',
      'tax_rates',
    ])
      await owner
        .$executeRawUnsafe(`DELETE FROM public.${t} WHERE ${where}`)
        .catch(() => undefined);
    await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
    await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
  }

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
    await setAppRoleLogin(owner, process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw');
    await cleanup();
    const mkOwner = (tag: string) =>
      owner.user.create({
        data: {
          email: `${PREFIX}${tag}-${run}@test.com`,
          passwordHash: 'x',
          firstName: tag,
          lastName: 'T',
          role: 'store_admin' as never,
        },
      });
    const o1 = await mkOwner('full');
    const o2 = await mkOwner('bare');
    const full = await owner.store.create({
      data: {
        slug: slugs.full,
        name: 'Parity Full',
        ownerId: o1.id,
        locationsEnabled: true,
        theme: { showBranchesInFooter: true },
        settings: { defaultLanguage: 'ar' },
      } as never,
    });
    await owner.store.create({ data: { slug: slugs.bare, name: 'Parity Bare', ownerId: o2.id } });
    const sid = full.id;
    await owner.storePage.createMany({
      data: [
        { storeId: sid, slug: 'privacy', title: 'P', isPublished: false },
        { storeId: sid, slug: 'terms', title: 'T', isPublished: false },
        { storeId: sid, slug: 'about', title: 'A', isPublished: true },
      ],
    });
    await owner.storeFaq.createMany({
      data: [
        { storeId: sid, question: 'q2', answer: 'a2', orderIndex: 2 },
        {
          storeId: sid,
          question: 'q1',
          questionAr: 'س١',
          answer: 'a1',
          answerAr: 'ج١',
          orderIndex: 1,
        },
        { storeId: sid, question: 'hidden', answer: 'x', orderIndex: 0, isActive: false },
      ],
    });
    await owner.storeHowto.createMany({
      data: [
        {
          storeId: sid,
          title: 'h1',
          description: 'd1',
          steps: [
            { name: 's1', text: 't1', image: 'https://x/y.png' },
            { name: 's2', text: 't2' },
          ],
          stepsAr: [{ name: 'خ١', text: 'ن١' }],
          orderIndex: 1,
        },
        { storeId: sid, title: 'h0', description: 'd0', steps: [], orderIndex: 0 },
      ],
    });
    await owner.storeLocation.createMany({
      data: [
        { storeId: sid, name: 'B2', country: 'Egypt', address: 'addr2', position: 2 },
        {
          storeId: sid,
          name: 'B1',
          nameAr: 'ف١',
          country: 'Egypt',
          address: 'addr1',
          phone: '+201012345678',
          position: 1,
        },
        {
          storeId: sid,
          name: 'hid',
          country: 'Egypt',
          address: 'x',
          isPublished: false,
          position: 0,
        },
      ],
    });

    app = express();
    app.use((_req: Request, res: Response, next: NextFunction) => {
      runWithRequestDb(
        () => createPrismaClient({ connectionString: appUrl(), max: 3 }),
        () =>
          new Promise<void>(resolve => {
            res.once('finish', resolve);
            res.once('close', resolve);
            next();
          })
      ).catch(next);
    });
    app.use('/api/v1/public', publicStoreContext, publicRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    await cleanup();
    await owner.$disconnect();
  });

  for (const which of ['full', 'bare'] as const) {
    it(`${which} store: the payload is byte-identical to the golden`, async () => {
      const r = await request(app)
        .get('/api/v1/public/store/resolve')
        .set('x-store-domain', `${slugs[which]}.ebda.app`);
      expect(r.status).toBe(200);
      const got = JSON.stringify(normalize(r.body, run), null, 2) + '\n';
      const file = path.join(GOLDEN, `store-resolve.${which}.json`);
      if (process.env.UPDATE_GOLDEN === '1') {
        fs.mkdirSync(GOLDEN, { recursive: true });
        fs.writeFileSync(file, got);
      }
      expect(got).toBe(fs.readFileSync(file, 'utf8'));
      if (which === 'full') {
        const d = (r.body.data ?? r.body).store ?? r.body.data;
        expect(JSON.stringify(r.body)).toContain('q1');
        expect(JSON.stringify(r.body)).toContain('B1');
        expect(JSON.stringify(r.body)).toContain('privacy');
        void d;
      }
    });
  }
});
