/** INSTAPAY-AUTO-1a (review item 8): the shared dedupe D1 is bound in wrangler, substituted or dropped by the deploy script, never pointed at a placeholder or at the platform D1. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script
import { withDedupeBinding } from '../../scripts/ebda-cf-api-config.mjs';
import { DEDUPE_SCHEMA_SQL } from '../../packages/shared/src/foundation/instapay-dedupe';

const WRANGLER = readFileSync(new URL('../../apps/api/wrangler.jsonc', import.meta.url), 'utf8');
const PLATFORM = '22222222-2222-4222-8222-222222222222';
const DEDUPE = '33333333-3333-4333-8333-333333333333';

describe('INSTAPAY_DEDUPE_DB binding', () => {
  it('wrangler.jsonc binds INSTAPAY_DEDUPE_DB to ebda-instapay-dedupe with its own migrations', () => {
    expect(WRANGLER).toMatch(/"binding":\s*"INSTAPAY_DEDUPE_DB"/);
    expect(WRANGLER).toMatch(/"database_name":\s*"ebda-instapay-dedupe"/);
    expect(WRANGLER).toContain('migrations/instapay-dedupe');
  });
  it('the deploy config substitutes the provisioned id', () => {
    const out = withDedupeBinding(WRANGLER, DEDUPE, PLATFORM);
    expect(out).toContain(DEDUPE);
    expect(out).not.toContain('11111111-1111-1111-1111-111111111111');
  });
  it('unset: the binding is dropped (never a placeholder in a deploy), the platform D1 stays', () => {
    const out = withDedupeBinding(WRANGLER, '', PLATFORM);
    expect(out).not.toContain('INSTAPAY_DEDUPE_DB');
    expect(out).toContain('"binding": "PLATFORM_DB"');
  });
  it('refuses a malformed id, the placeholder, or the platform D1 id', () => {
    expect(() => withDedupeBinding(WRANGLER, 'nope', PLATFORM)).toThrow();
    expect(() =>
      withDedupeBinding(WRANGLER, '11111111-1111-1111-1111-111111111111', PLATFORM)
    ).toThrow();
    expect(() => withDedupeBinding(WRANGLER, PLATFORM, PLATFORM)).toThrow(/platform/);
  });
  it('the dedupe migration is byte-for-byte the vendored foundation schema', () => {
    const sql = readFileSync(
      new URL('../../packages/cf-schema/migrations/instapay-dedupe/0001_init.sql', import.meta.url),
      'utf8'
    );
    expect(sql).toContain(DEDUPE_SCHEMA_SQL);
  });
});
