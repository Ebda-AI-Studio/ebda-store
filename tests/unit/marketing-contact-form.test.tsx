// @vitest-environment jsdom
/**
 * The /contact enquiry form (Ruling CONTACT-FORM-1): renders in Arabic and English with labelled, required fields and the
 * seven BRAND services; shows per-field errors wired with aria-describedby and moves focus to the first one; posts JSON
 * with the honeypot and fill time; shows a role=status success; shows an error (never success) when the API fails; has a
 * real form action for the no-JavaScript post.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BRAND } from '../../packages/shared/src/brand';
import { ContactForm, CONTACT_ENDPOINT } from '../../apps/marketing/src/components/ContactForm';
import { COPY } from '../../apps/marketing/src/lib/content';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

const reply = (status: number, body: unknown) =>
  fetchMock.mockResolvedValue({ ok: status < 300, status, json: async () => body });

function fill(c: HTMLElement, o: Partial<Record<string, string>> = {}) {
  const set = (name: string, v: string) =>
    fireEvent.change(c.querySelector(`[name="${name}"]`)!, { target: { value: v } });
  set('name', o.name ?? 'منى');
  set('phone', o.phone ?? '01012345678');
  set('email', o.email ?? 'mona@example.com');
  set('topic', o.topic ?? 'marketing');
  set('message', o.message ?? 'محتاجة تصوير لأربعين منتج');
  if (o.consent !== 'off') fireEvent.click(c.querySelector('[name="consent"]')!);
}

describe.each(['ar', 'en'] as const)('ContactForm (%s)', locale => {
  const f = COPY[locale].contactPage.form;

  it('renders labelled, required fields, the seven services, the privacy link and a real form action', () => {
    const { container } = render(<ContactForm locale={locale} />);
    const form = container.querySelector('form')!;
    expect(form.getAttribute('method')).toBe('post');
    expect(form.getAttribute('action')).toBe(CONTACT_ENDPOINT);
    for (const n of ['name', 'phone', 'email', 'topic', 'message', 'consent']) {
      const el = container.querySelector<HTMLElement>(`[name="${n}"]`)!;
      expect(el.hasAttribute('required')).toBe(true);
      expect(container.querySelector(`label[for="${el.id}"]`)).not.toBeNull();
    }
    expect(container.querySelector<HTMLElement>('[name="company"]')!.hasAttribute('required')).toBe(
      false
    );
    const options = [
      ...container.querySelectorAll<HTMLOptionElement>('select[name="topic"] option'),
    ].map(o => o.value);
    for (const s of BRAND.services) expect(options).toContain(s.id);
    expect(options).toEqual(expect.arrayContaining(['store-support', 'chat-support', 'other']));
    const link = container.querySelector<HTMLAnchorElement>('.cf-consent a')!;
    expect(link.getAttribute('href')).toContain('privacy');
    expect(link.textContent).toBe(f.consentLink);
    expect(container.querySelector('input[name="lang"]')!.getAttribute('value')).toBe(locale);
    // honeypot is out of the tab order and hidden from assistive tech
    const hp = container.querySelector<HTMLInputElement>('input[name="website"]')!;
    expect(hp.tabIndex).toBe(-1);
    expect(hp.closest('[aria-hidden="true"]')).not.toBeNull();
    // the live region exists before anything is announced
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  });

  it('shows per-field errors with aria-describedby, focuses the first, and does not post', async () => {
    const { container } = render(<ContactForm locale={locale} />);
    fireEvent.submit(container.querySelector('form')!);
    const name = container.querySelector<HTMLInputElement>('[name="name"]')!;
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    const errId = name.getAttribute('aria-describedby')!.split(' ')[0];
    expect(container.ownerDocument.getElementById(errId)!.textContent).toBe(f.errors.required);
    expect(document.activeElement).toBe(name);
    expect(container.querySelector('.cf-summary[role="alert"]')!.textContent).toContain(
      f.errorSummary
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a bad phone and email locally with their own messages', async () => {
    const { container } = render(<ContactForm locale={locale} />);
    fill(container, { phone: '123', email: 'nope' });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.querySelector('.cf-err')).not.toBeNull());
    const msgs = [...container.querySelectorAll('.cf-err')].map(e => e.textContent);
    expect(msgs.join(' ')).toContain(f.errors.invalid_phone);
    expect(msgs.join(' ')).toContain(f.errors.invalid_email);
  });

  it('posts JSON (honeypot + fill time included) and shows a role=status success with focus on it', async () => {
    reply(200, { success: true, data: { requestId: 'r1' } });
    const { container } = render(<ContactForm locale={locale} />);
    fill(container);
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.querySelector('[aria-live="polite"] h3')).not.toBeNull());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CONTACT_ENDPOINT);
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({
      phone: '01012345678',
      topic: 'marketing',
      consent: true,
      lang: locale,
      website: '',
    });
    expect(typeof sent.fillMs).toBe('number');
    const h = container.querySelector<HTMLElement>('[aria-live="polite"] h3')!;
    expect(h.textContent).toBe(f.sentH);
    expect(document.activeElement).toBe(h);
    expect(container.querySelector('form')).toBeNull();
  });

  it('never shows success when the API says the send failed; offers WhatsApp/email instead', async () => {
    reply(502, { success: false, error: { code: 'SEND_FAILED', message: 'x' } });
    const { container } = render(<ContactForm locale={locale} />);
    fill(container);
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.querySelector('.cf-banner')).not.toBeNull());
    expect(container.querySelector('.cf-banner')!.textContent).toContain(f.failed);
    expect(container.querySelector('.cf-banner a')!.getAttribute('href')).toBe(
      `mailto:${BRAND.supportEmail}`
    );
    expect(container.querySelector('[aria-live="polite"] h3')).toBeNull();
    expect(container.querySelector('form')).not.toBeNull();
  });

  it('maps server field errors, a rate limit and a network failure to localised messages', async () => {
    reply(400, {
      success: false,
      error: { code: 'VALIDATION_ERROR', fields: { email: 'invalid_email' } },
    });
    const a = render(<ContactForm locale={locale} />);
    fill(a.container);
    fireEvent.submit(a.container.querySelector('form')!);
    await waitFor(() =>
      expect(a.container.querySelector('.cf-err')!.textContent).toContain(f.errors.invalid_email)
    );
    cleanup();

    reply(429, { success: false, error: { code: 'RATE_LIMITED' } });
    const b = render(<ContactForm locale={locale} />);
    fill(b.container);
    fireEvent.submit(b.container.querySelector('form')!);
    await waitFor(() =>
      expect(b.container.querySelector('.cf-banner')!.textContent).toContain(f.rateLimited)
    );
    cleanup();

    fetchMock.mockRejectedValue(new Error('offline'));
    const c = render(<ContactForm locale={locale} />);
    fill(c.container);
    fireEvent.submit(c.container.querySelector('form')!);
    await waitFor(() =>
      expect(c.container.querySelector('.cf-banner')!.textContent).toContain(f.failed)
    );
  });

  it('has static no-JavaScript result panels for the redirect anchors', () => {
    const { container } = render(<ContactForm locale={locale} />);
    expect(container.querySelector('#sent')!.textContent).toContain(f.sentH);
    expect(container.querySelector('#send-failed')!.textContent).toContain(f.failed);
  });
});
