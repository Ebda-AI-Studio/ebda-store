/** Rate limits of the studio enquiry form: 5/hour per IP and 5/hour per email, each independent (Ruling CONTACT-FORM-1). */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
// The shared store factory pulls the whole database layer; an undefined store is express-rate-limit's in-memory one.
vi.mock('@api/middleware/security', () => ({
  makeRateLimitStore: () => undefined,
  rateLimitRedisClient: () => null,
}));

import {
  contactEmailKey,
  createContactEnquiryLimiters,
} from '@api/middleware/contact-enquiry-limiters';

function app(prefix: string) {
  const { ip, email } = createContactEnquiryLimiters({ skip: () => false, prefix });
  const a = express();
  a.set('trust proxy', true);
  a.use(express.json());
  a.post('/e', ip, email, (_req, res) => res.json({ ok: true }));
  return a;
}
const send = (a: express.Express, email: string, ip: string) =>
  request(a).post('/e').set('X-Forwarded-For', ip).send({ email });

describe('contact enquiry limiters', () => {
  it('429s the 6th request from one IP within the hour, even with a new email each time', async () => {
    const a = app('t-ip');
    for (let i = 0; i < 5; i++)
      expect((await send(a, `u${i}@example.com`, '9.9.9.9')).status).toBe(200);
    const res = await send(a, 'u9@example.com', '9.9.9.9');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('429s the 6th request for one email, even from a new IP each time', async () => {
    const a = app('t-email');
    for (let i = 0; i < 5; i++)
      expect((await send(a, 'Same@Example.com', `8.8.8.${i}`)).status).toBe(200);
    expect((await send(a, 'same@example.com', '8.8.8.99')).status).toBe(429);
  });

  it('keys the email budget on the normalised address', () => {
    expect(contactEmailKey({ body: { email: '  A@B.CO ' } } as any)).toBe('a@b.co');
    expect(contactEmailKey({ body: {} } as any)).toBe('no-email');
  });
});
