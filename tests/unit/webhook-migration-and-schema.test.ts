// Merchant webhooks: the tables are tenant-scoped with strict RLS + FORCE, granted to ebda_app,
// cascade on store delete; and the shared request contracts refuse unsafe URLs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  webhookEndpointCreateSchema,
  webhookEndpointUpdateSchema,
  webhookUrlShapeError,
  planIncludesWebhooks,
  WEBHOOK_RETRY_DELAYS_SEC,
  WEBHOOK_MAX_ATTEMPTS,
} from '@ebda/shared';

const DIR = resolve(
  __dirname,
  '../../packages/database/prisma/migrations/20261025000100_merchant_webhooks'
);
const sql = readFileSync(resolve(DIR, 'migration.sql'), 'utf8')
  .split('\n')
  .filter(l => !l.trim().startsWith('--'))
  .join('\n');

describe.each(['webhook_endpoints', 'webhook_deliveries'])('%s', table => {
  it('has strict RLS + FORCE and the single tenant policy, no bypass', () => {
    expect(sql).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    expect(sql).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    expect(sql).toMatch(
      new RegExp(
        `CREATE POLICY ebda_tenant_isolation ON ${table} AS PERMISSIVE FOR ALL TO ebda_app\\s+USING \\(store_id = nullif\\(current_setting\\('app.current_store_id', true\\), ''\\)\\)\\s+WITH CHECK \\(store_id = nullif\\(current_setting\\('app.current_store_id', true\\), ''\\)\\)`
      )
    );
    expect(sql).toMatch(new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ebda_app`));
    expect(sql).not.toMatch(/bypass_rls|IS NULL/);
  });
  it('cascades on store delete', () => {
    expect(sql).toMatch(
      new RegExp(
        `"${table}_store_id_fkey" FOREIGN KEY \\("store_id"\\) REFERENCES "stores"\\("id"\\) ON DELETE CASCADE`
      )
    );
  });
});

describe('endpoint contracts', () => {
  const ok = { url: 'https://hooks.example.com/ebda', events: ['order.created'] };
  it('accepts a public https url and dedupes events', () => {
    const r = webhookEndpointCreateSchema.parse({
      ...ok,
      events: ['order.created', 'order.created'],
    });
    expect(r.events).toEqual(['order.created']);
    expect(r.includeCustomer).toBe(false);
  });
  it.each([
    'http://hooks.example.com/x',
    'https://user:pw@hooks.example.com/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://2130706433/x',
    'ftp://hooks.example.com',
    'http://0x7f000001/',
    'https://0x7f000001/',
    'https://0177.0.0.1/',
    'https://127.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://100.64.0.1/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:7f00:1]/',
    'https://[fd00::1]/',
    'https://hooks.example.com:8443/x',
    'https://hooks.example.com:80/x',
    'https://app.internal/x',
    'https://printer.local/x',
    'https://localhost./x',
    'not a url',
  ])('rejects %s', url => {
    expect(webhookEndpointCreateSchema.safeParse({ ...ok, url }).success).toBe(false);
    expect(webhookUrlShapeError(url)).not.toBeNull();
  });
  it('rejects unknown events, empty events and unknown keys', () => {
    expect(
      webhookEndpointCreateSchema.safeParse({ ...ok, events: ['order.exploded'] }).success
    ).toBe(false);
    expect(webhookEndpointCreateSchema.safeParse({ ...ok, events: [] }).success).toBe(false);
    expect(webhookEndpointCreateSchema.safeParse({ ...ok, storeId: 'x' }).success).toBe(false);
    expect(webhookEndpointUpdateSchema.safeParse({}).success).toBe(false);
  });
  it('plan gate is Growth + Business only', () => {
    expect(planIncludesWebhooks('growth')).toBe(true);
    expect(planIncludesWebhooks('business')).toBe(true);
    expect(planIncludesWebhooks('basic')).toBe(false);
    expect(planIncludesWebhooks('free')).toBe(false);
  });
  it('retry schedule is 6 bounded attempts over about 24h', () => {
    expect(WEBHOOK_RETRY_DELAYS_SEC).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    const total = WEBHOOK_RETRY_DELAYS_SEC.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(23 * 3600);
    expect(total).toBeLessThanOrEqual(25 * 3600);
  });
});
