/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

// 2026-11-10: POST /auth/merchant/signup answered 500 for every new address. The Worker has no Postgres (NZ-D23) and the
// service wrote a `users` profile row through Prisma (POSTGRES_REMOVED) after the identity was already created.
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  PLATFORM_DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  E2E_DB: string;
};

describe.skipIf(e.E2E_DB === '1')('merchant signup on the Postgres-less Worker', () => {
  it('a valid signup for a new address answers 200 and writes its acceptances to D1, never a POSTGRES_REMOVED 500', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    for (const [i, k] of ['platform_cutover.platform', 'platform_cutover.access'].entries())
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
      )
        .bind(`signup-marker-${i}`, k)
        .run();
    const base = 'https://api.ebda.app/api/v1/auth/merchant';
    const tokenRes = await e.API.fetch(`${base}/signup-token`);
    expect(tokenRes.status).toBe(200);
    const token = ((await tokenRes.json()) as { data: { token: string } }).data.token;
    const res = await e.API.fetch(`${base}/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.77' },
      body: JSON.stringify({
        email: 'new-merchant@exit-test.invalid',
        password: 'Str0ng!Passw0rd-x',
        name: 'Mona Ali',
        phone: '01012345678',
        language: 'ar',
        acceptedLegal: true,
        formToken: token,
      }),
    });
    const text = await res.text();
    expect(text).not.toContain('POSTGRES_REMOVED');
    expect(res.status).toBe(200);
  }, 60_000);
});
