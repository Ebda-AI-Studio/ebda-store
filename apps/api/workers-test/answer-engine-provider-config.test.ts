/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { accessToken, authState, api } from './helpers';

// Ported from tests/integration/answer-engine/provider-config.test.ts (Postgres, a running API at localhost:4000) to the built Worker + D1
// platform family (`ops`, where the router serves AnswerEngineProviderConfig): PUT /admin/answer-engine/providers/:engine stores the key ENCRYPTED
// (the D1 column never holds the plaintext) and sets enabled; GET returns it MASKED (`****`, the plaintext is nowhere in the body); a second PUT
// with the masked value round-tripped does NOT clobber the stored ciphertext while `enabled` still flips; a store_admin gets 403 on both verbs;
// a super_admin WITHOUT MFA is refused 403 MFA_SETUP_REQUIRED on both. The decrypt round-trip of the stored key is covered by
// tests/unit/encryption-service.test.ts (the stored value is the same `encryption.encrypt` output).
const e = env as unknown as {
  TEST_PLATFORM_MIGRATIONS: unknown[];
  PLATFORM_DB: {
    prepare(sql: string): {
      bind(...v: unknown[]): {
        run(): Promise<unknown>;
        first<T = Record<string, unknown>>(): Promise<T | null>;
      };
    };
  };
};
let ip = 0;
async function call(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await api.fetch(`https://api.ebda.app/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'cf-connecting-ip': `10.93.${(ip >> 8) & 255}.${ip++ & 255}`,
      origin: 'http://localhost:3001',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON answer
  }
  return { status: res.status, json, text };
}
const PLAINTEXT_KEY = 'pplx-secret-123';
let superToken = '';
let noMfaToken = '';
let storeAdminToken = '';
const row = () =>
  e.PLATFORM_DB.prepare(
    'SELECT api_key, enabled FROM answer_engine_provider_configs WHERE engine = ?1'
  )
    .bind('perplexity')
    .first<{ api_key: string | null; enabled: number }>();
const put = (token: string, body: unknown) =>
  call('/admin/answer-engine/providers/perplexity', { method: 'PUT', token, body });
const list = (token: string) => call('/admin/answer-engine/providers', { token });

describe('answer-engine provider config on the Worker (encrypted key + mask discipline)', () => {
  beforeAll(async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    await e.PLATFORM_DB.prepare(
      'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
    )
      .bind('aep-ops-marker', 'platform_cutover.ops')
      .run();
    for (const [id, role] of [
      ['super-aep', 'super_admin'],
      ['nomfa-aep', 'super_admin'],
      ['sa-aep', 'store_admin'],
    ] as const)
      await authState(`user:tv:${id}`, [['set', `user:tv:${id}`, '0', {}]]);
    superToken = await accessToken({ userId: 'super-aep', jti: 'j-aep-su', role: 'super_admin' });
    noMfaToken = await accessToken({ userId: 'nomfa-aep', jti: 'j-aep-nm', role: 'super_admin' });
    storeAdminToken = await accessToken({ userId: 'sa-aep', jti: 'j-aep-sa', role: 'store_admin' });
  });

  it('PUT with a plaintext apiKey stores it ENCRYPTED (never plaintext) and sets enabled', async () => {
    const res = await put(superToken, { apiKey: PLAINTEXT_KEY, enabled: true });
    expect(res.status, res.text).toBe(200);
    const r = await row();
    expect(r).not.toBeNull();
    expect(r!.enabled).toBe(1);
    expect(r!.api_key).toBeTruthy();
    expect(r!.api_key).not.toBe(PLAINTEXT_KEY);
    expect(r!.api_key).not.toContain(PLAINTEXT_KEY);
  });

  it('GET returns the key MASKED (contains ****, never the plaintext)', async () => {
    const res = await list(superToken);
    expect(res.status, res.text).toBe(200);
    const perplexity = res.json.data.configs.find(
      (c: { engine: string }) => c.engine === 'perplexity'
    );
    expect(perplexity.enabled).toBe(true);
    expect(perplexity.apiKeyMasked).toContain('****');
    expect(perplexity.apiKeyMasked).not.toContain(PLAINTEXT_KEY);
    expect(res.text).not.toContain(PLAINTEXT_KEY);
  });

  it('a second PUT with the masked sentinel value does NOT clobber the stored secret', async () => {
    const before = (await row())!.api_key;
    const masked = (await list(superToken)).json.data.configs.find(
      (c: { engine: string }) => c.engine === 'perplexity'
    ).apiKeyMasked;
    const res = await put(superToken, { apiKey: masked, enabled: false });
    expect(res.status, res.text).toBe(200);
    const after = await row();
    expect(after!.enabled).toBe(0);
    expect(after!.api_key).toBe(before); // the stored ciphertext is untouched by the masked round-trip
  });

  it('a non-super-admin (store_admin) caller gets 403 on GET and PUT', async () => {
    expect((await list(storeAdminToken)).status).toBe(403);
    expect((await put(storeAdminToken, { apiKey: 'whatever', enabled: true })).status).toBe(403);
  });

  it('a super_admin WITHOUT MFA enrolled is blocked (403 MFA_SETUP_REQUIRED) on GET and PUT', async () => {
    const g = await list(noMfaToken);
    expect(g.status).toBe(403);
    expect(g.json.error.code).toBe('MFA_SETUP_REQUIRED');
    const p = await put(noMfaToken, { apiKey: 'whatever', enabled: true });
    expect(p.status).toBe(403);
    expect(p.json.error.code).toBe('MFA_SETUP_REQUIRED');
  });
});
