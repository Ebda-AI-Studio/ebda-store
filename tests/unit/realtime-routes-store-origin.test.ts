/**
 * #622 follow-up / Ruling CORS-TB-3 — `/realtime/*` refuses store origins on its own.
 *
 * The StoreRealtime DO calls these routes server-to-server (no Origin). They must not rely on
 * the Worker's `/socket.io/` upgrade check to keep a merchant-controlled page out: a store
 * origin gets a 403 BEFORE any token is read, even a valid admin token.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authSpy } = vi.hoisted(() => ({ authSpy: vi.fn() }));

vi.mock('@ebda/database', () => ({ prisma: {}, withUser: vi.fn() }));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    authSpy();
    req.user = { userId: 'owner-b', email: 'o@b.test', role: 'store_admin', storeId: null };
    next();
  },
}));

import realtimeRoutes from '@api/routes/realtime.routes';

const app = express();
app.use('/api/v1/realtime', realtimeRoutes);

describe('/realtime routes vs request origin', () => {
  it.each(['https://shop-a.com', 'https://shop-a.ebda.app', 'https://evil.example', 'null'])(
    'refuses store origin %s before authenticating',
    async origin => {
      authSpy.mockClear();
      for (const path of ['/api/v1/realtime/session', '/api/v1/realtime/stores/store-b/access']) {
        const r = await request(app).get(path).set('Origin', origin).set('Cookie', 'token=x');
        expect(r.status, `${origin} ${path}`).toBe(403);
        expect(r.body.error.code).toBe('ORIGIN_NOT_PERMITTED');
      }
      expect(authSpy).not.toHaveBeenCalled();
    }
  );

  it('serves the DO (no Origin) and platform origins', async () => {
    for (const headers of [{}, { Origin: 'https://store.ebda.app' }]) {
      const r = await request(app).get('/api/v1/realtime/session').set(headers);
      expect(r.status).toBe(200);
      expect(r.body.data.userId).toBe('owner-b');
    }
  });
});
