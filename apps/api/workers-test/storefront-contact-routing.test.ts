/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { CONTACT_HONEYPOT_FIELD } from '@ebda/shared';
import { bootstrapMerchant, call, type Merchant } from './merchant-fixture';
import { doSetStoreFields } from './do-read';

// Route-level half of tests/integration/storefront-contact-routing.test.ts, on the built Worker + StoreDO: POST /public/contact names the store
// the shopper wrote on (X-Store-ID wins over x-store-domain, a body storeId is ignored), refuses a message that names no store (400
// STORE_NOT_RESOLVED), refuses a demo store in both languages (403 DEMO_STORE) and answers a filled honeypot of any length with a silent success.
// The original stays for what a Worker test cannot observe (inngest.send payload, the per-store Redis cap window) and for storeContactTarget
// (still a Prisma read of stores.email + owner): see the PR description.
const MESSAGE = {
  name: 'Mona',
  email: 'mona@example.test',
  subject: 'Size question',
  message: 'Do you have it in M?',
};
let shop: Merchant;
let demo: Merchant;
let other: Merchant;
const post = (
  storeId: string | null,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) =>
  call('/public/contact', {
    method: 'POST',
    body,
    headers: { ...(storeId ? { 'x-store-id': storeId } : {}), ...headers },
  });

describe('storefront contact routing on the Worker (FU46-1)', () => {
  beforeAll(async () => {
    shop = await bootstrapMerchant('ctc-shop');
    demo = await bootstrapMerchant('ctc-demo');
    other = await bootstrapMerchant('ctc-other');
    await doSetStoreFields(demo.storeId, { isDemo: true });
  }, 120_000);

  it('accepts the message for the store it was written on', async () => {
    const res = await post(shop.storeId, MESSAGE);
    expect(res.status, res.text).toBe(200);
    expect(res.json.success).toBe(true);
  });

  it('refuses a message that names no store', async () => {
    const res = await post(null, MESSAGE);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('STORE_NOT_RESOLVED');
  });

  it('a demo store refuses, in both languages', async () => {
    const res = await post(demo.storeId, MESSAGE);
    expect(res.status, res.text).toBe(403);
    expect(res.json.error.code).toBe('DEMO_STORE');
    expect(res.json.error.details.messageAr).toBeTruthy();
    expect(res.json.error.details.messageEn).toBeTruthy();
  });

  it('a filled honeypot of any length is a silent success on a live store and on a demo store (never a 400, never the demo 403)', async () => {
    for (const trap of ['http://spam', 'x'.repeat(5000)]) {
      const res = await post(shop.storeId, { ...MESSAGE, [CONTACT_HONEYPOT_FIELD]: trap });
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
    }
    // the trap is checked before the demo refusal: a bot learns nothing about the store
    const d = await post(demo.storeId, { ...MESSAGE, [CONTACT_HONEYPOT_FIELD]: 'http://spam' });
    expect(d.status).toBe(200);
  });

  it('X-Store-ID wins over a conflicting x-store-domain, and a body storeId is ignored', async () => {
    // the demo store is named by the header: it refuses (proves the header decided), the conflicting domain / body ids did not
    const res = await post(
      demo.storeId,
      { ...MESSAGE, storeId: other.storeId },
      { 'x-store-domain': `${other.slug}.ebda.app` }
    );
    expect(res.status, res.text).toBe(403);
    expect(res.json.error.code).toBe('DEMO_STORE');
    const ok = await post(
      shop.storeId,
      { ...MESSAGE, storeId: demo.storeId },
      { 'x-store-domain': `${demo.slug}.ebda.app` }
    );
    expect(ok.status, ok.text).toBe(200);
  });
});
