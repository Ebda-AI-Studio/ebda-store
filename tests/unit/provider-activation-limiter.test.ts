/**
 * SELF-SERVICE gap A7: the "Test and turn on" preview calls the provider (and may spend one AI explanation), so it
 * is limited per store + provider; super_admin (the override) is never limited.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createProviderActivationLimiter } from '@api/middleware/provider-activation-limiter';

describe('provider activation preview limiter', () => {
  it('the preview limiter allows N per store + provider, never limits super_admin', async () => {
    const { createProviderActivationLimiter } =
      await import('@api/middleware/provider-activation-limiter');
    const lim = createProviderActivationLimiter({
      skip: (r: any) => r.user?.role === 'super_admin',
    });
    const a = express();
    a.use((req: any, _r, n) => {
      req.user = { role: req.header('x-role') };
      n();
    });
    a.post('/:storeId/:provider', lim, (_q, r) => void r.status(200).json({}));
    const post = (s: string, p: string, role = 'store_admin') =>
      request(a).post(`/${s}/${p}`).set('x-role', role);
    for (let i = 0; i < 10; i++) expect((await post('lim-s1', 'kashier')).status).toBe(200);
    expect((await post('lim-s1', 'kashier')).status).toBe(429);
    expect((await post('lim-s1', 'paymob')).status).toBe(200);
    expect((await post('lim-s2', 'kashier')).status).toBe(200);
    expect((await post('lim-s1', 'kashier', 'super_admin')).status).toBe(200);
  });
});
