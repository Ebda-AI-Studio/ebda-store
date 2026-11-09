/**
 * POST /public/contact/enquiry (Ruling CONTACT-FORM-1): validation, honeypot, fill time, escaped email content,
 * the failure path (never a success, a P1 alert, no PII in the alert or the logs) and the no-JS redirect.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({
  send: vi.fn(),
  receipt: vi.fn(),
  alert: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@api/middleware/contact-enquiry-limiters', () => ({
  contactEnquiryLimiters: {
    ip: (_q: any, _s: any, n: any) => n(),
    email: (_q: any, _s: any, n: any) => n(),
  },
}));
vi.mock('@api/services/email.service', () => ({
  EmailService: { sendContactEnquiry: m.send, sendContactEnquiryReceipt: m.receipt },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: m.alert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: m.info, warn: m.warn, error: vi.fn(), debug: vi.fn() },
}));

let app: Express;
beforeAll(async () => {
  const { default: router } = await import('@api/routes/contact-enquiry-public.routes');
  app = express();
  app.use('/public/contact', router);
});
beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.send.mockResolvedValue(undefined);
  m.receipt.mockResolvedValue(undefined);
  m.alert.mockResolvedValue('sent');
});

const good = () => ({
  name: 'Mona <b>Ali</b>',
  company: '',
  phone: '٠١٠١٢٣٤٥٦٧٨',
  email: '  Mona@Example.COM ',
  topic: 'marketing',
  message: 'I need product photos for 40 items. <script>alert(1)</script>',
  consent: true,
  lang: 'en',
  website: '',
  fillMs: 20000,
});
const post = (body: unknown) =>
  request(app)
    .post('/public/contact/enquiry')
    .send(body as object);

describe('validation at the edge', () => {
  it('accepts a good enquiry, normalises phone and email, and sends both mails', async () => {
    const res = await post(good());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const arg = m.send.mock.calls[0][0];
    expect(arg.phone).toBe('+201012345678');
    expect(arg.phoneDisplay).toBe('+20 101 234 5678');
    expect(arg.email).toBe('mona@example.com');
    expect(arg.topicLabel).toBe('Marketing, advertising and media');
    expect(m.receipt).toHaveBeenCalledWith(
      'mona@example.com',
      expect.objectContaining({ lang: 'en' })
    );
  });

  it.each([
    [{ name: '' }, 'name', 'required'],
    [{ phone: '12345' }, 'phone', 'invalid_phone'],
    [{ email: 'not-an-email' }, 'email', 'invalid_email'],
    [{ topic: 'hacking' }, 'topic', 'invalid_topic'],
    [{ message: 'short' }, 'message', 'too_short'],
    [{ message: 'x'.repeat(4001) }, 'message', 'too_long'],
    [{ name: 'n'.repeat(101) }, 'name', 'too_long'],
    [{ consent: false }, 'consent', 'consent_required'],
  ])('rejects %j with a field code and sends nothing', async (patch, field, code) => {
    const res = await post({ ...good(), ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fields[field]).toBe(code);
    expect(m.send).not.toHaveBeenCalled();
  });

  it('never echoes visitor text in an error response', async () => {
    const res = await post({ ...good(), email: 'SECRET-MARKER', name: '' });
    expect(JSON.stringify(res.body)).not.toContain('SECRET-MARKER');
  });
});

describe('spam controls', () => {
  it('a filled honeypot gets a fake success and no email', async () => {
    const res = await post({ ...good(), website: 'http://spam.example' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.receipt).not.toHaveBeenCalled();
    expect(m.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'honeypot' }),
      'contact.enquiry'
    );
  });

  it('a form filled faster than the minimum time is refused, not silently dropped', async () => {
    const res = await post({ ...good(), fillMs: 400 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_FAST');
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe('the email carries visitor text unescaped only as data', () => {
  it('builds the studio mail with escaped HTML (script and tags inert)', async () => {
    const { contactEnquiryHtml } = await import('@api/services/email-templates/contact-enquiry');
    await post(good());
    const html = contactEnquiryHtml(m.send.mock.calls[0][0]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Ali</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Mona &lt;b&gt;Ali&lt;/b&gt;');
  });

  it('strips line breaks from single-line fields (no header injection via name)', async () => {
    await post({ ...good(), name: 'Mona\r\nBcc: evil@example.com' });
    expect(m.send.mock.calls[0][0].name).toBe('Mona Bcc: evil@example.com');
  });
});

describe('failure path', () => {
  it('a failed send is a 502 SEND_FAILED, never a success, with a P1 alert free of visitor data', async () => {
    m.send.mockRejectedValue(new Error('provider down for mona@example.com'));
    const res = await post(good());
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('SEND_FAILED');
    expect(m.receipt).not.toHaveBeenCalled();
    expect(m.alert).toHaveBeenCalledTimes(1);
    const alert = m.alert.mock.calls[0][0];
    expect(alert.level).toBe('p1');
    expect(JSON.stringify(alert)).not.toMatch(/mona|example\.com|photos/i);
  });

  it('a failed receipt does not turn a delivered enquiry into an error', async () => {
    m.receipt.mockRejectedValue(new Error('x'));
    const res = await post(good());
    expect(res.status).toBe(200);
    expect(m.alert).not.toHaveBeenCalled();
  });

  it('logs only a request id and an outcome, never visitor data', async () => {
    await post(good());
    m.send.mockRejectedValueOnce(new Error('boom'));
    await post(good());
    const logged = JSON.stringify([...m.info.mock.calls, ...m.warn.mock.calls]);
    expect(logged).toMatch(/"outcome":"sent"/);
    expect(logged).toMatch(/"outcome":"send_failed"/);
    expect(logged).not.toMatch(/mona|example\.com|photos|1012345678/i);
  });
});

describe('form post without JavaScript', () => {
  const form = (o: Record<string, string>) =>
    request(app).post('/public/contact/enquiry').type('form').send(o);
  const fields = {
    name: 'Mona',
    phone: '01012345678',
    email: 'mona@example.com',
    topic: 'other',
    message: 'Hello, I need a quote please.',
    consent: 'on',
    lang: 'en',
  };

  it('303s to a fixed marketing URL on success (consent "on" accepted)', async () => {
    const res = await form(fields);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('https://ebda.app/en/contact/#sent');
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it('303s to the failure anchor when the send fails or the data is invalid', async () => {
    m.send.mockRejectedValue(new Error('x'));
    const failed = await form({ ...fields, lang: 'ar' });
    expect(failed.headers.location).toBe('https://ebda.app/contact/#send-failed');
    const invalid = await form({ ...fields, email: 'nope' });
    expect(invalid.status).toBe(303);
    expect(invalid.headers.location).toBe('https://ebda.app/en/contact/#send-failed');
  });
});
