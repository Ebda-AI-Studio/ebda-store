/**
 * RFC 8058 one-click unsubscribe on lifecycle mail (Gmail/Yahoo bulk-sender rule). Campaign, newsletter and
 * cart-recovery sends already carry the headers (campaign.service#listUnsubscribeHeaders); this covers the
 * lifecycle path through the queue, and that the one-click POST works without login and is idempotent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const m = vi.hoisted(() => ({ enqueue: vi.fn(), optOut: vi.fn(), resendSend: vi.fn() }));
vi.mock('@api/config', () => ({
  config: {
    jwtSecret: 'j',
    encryptionKey: 'test-encryption-key-0123456789abcdef',
    apiUrl: 'https://api.ebda.app',
  },
}));
vi.mock('@ebda/database', () => ({ prisma: {}, withStore: vi.fn() }));
vi.mock('@api/lib/logger', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@api/services/store-mailer.service', () => ({
  StoreMailer: { isConfigured: () => true },
}));
vi.mock('@api/services/email-queue.service', () => ({ emailQueue: { enqueue: m.enqueue } }));
vi.mock('@api/middleware/security', () => ({ publicLimiter: (_q: any, _r: any, n: any) => n() }));
vi.mock('@api/services/lifecycle-emails.service', () => ({
  optOut: m.optOut,
  listLifecycleLog: vi.fn(),
}));

import { EmailService } from '@api/services/email.service';
import {
  lifecycleUnsubscribeUrl,
  oneClickUnsubscribeHeaders,
} from '@api/lib/lifecycle-unsubscribe-token';

const STORE = '11111111-1111-4111-8111-111111111111';
const links = { products: 'p', payment: 'q', storefront: 's', billing: 'b' };

beforeEach(() => {
  m.enqueue.mockReset();
  m.optOut.mockReset();
});

describe('oneClickUnsubscribeHeaders', () => {
  it('advertises exactly the signed https URL plus the one-click post marker', () => {
    const url = lifecycleUnsubscribeUrl(STORE);
    expect(oneClickUnsubscribeHeaders(url)).toEqual({
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
  it('never advertises a non-https (local/dev) URL', () => {
    expect(oneClickUnsubscribeHeaders('http://localhost:4000/x?token=t')).toBeUndefined();
  });
});

describe('lifecycle email carries the headers through the queue', () => {
  it('enqueues with List-Unsubscribe + List-Unsubscribe-Post', async () => {
    const unsubscribeUrl = lifecycleUnsubscribeUrl(STORE);
    await EmailService.sendLifecycleEmail(
      { kind: 'share_link', to: 'o@example.com', storeName: 'N', links, unsubscribeUrl },
      'en'
    );
    const [storeId, options] = m.enqueue.mock.calls[0];
    expect(storeId).toBeNull();
    expect(options.headers).toEqual({
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
  it('order/billing mail is untouched: no headers key on a normal platform send', async () => {
    const src = (await import('node:fs')).readFileSync(
      new URL('../../apps/api/src/services/email.service.ts', import.meta.url),
      'utf8'
    );
    expect(src.match(/oneClickUnsubscribeHeaders\(/g)?.length).toBe(1);
  });
});

describe('one-click POST (what a mailbox provider sends)', () => {
  it('works with no login or cookie, takes the token from the URL, and is idempotent', async () => {
    const { default: pub } = await import('@api/routes/lifecycle-emails-public.routes');
    const app = express();
    app.use('/public/lifecycle-emails', pub);
    const url = new URL(lifecycleUnsubscribeUrl(STORE));
    const path = `${url.pathname.replace('/api/v1', '')}${url.search}`;
    m.optOut.mockResolvedValue(undefined);
    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post(`/public${path.replace(/^\/public/, '')}`)
        .type('form')
        .send('List-Unsubscribe=One-Click');
      expect(res.status).toBe(200);
    }
    expect(m.optOut).toHaveBeenCalledTimes(2);
    expect(m.optOut).toHaveBeenCalledWith(STORE);
  });
});
