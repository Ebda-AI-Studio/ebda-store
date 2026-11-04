/**
 * /contact page wiring + the marketing CSP for the enquiry form (Ruling CONTACT-FORM-1): the form is on both locales,
 * About's talk CTA goes there, and the CSP lets a form post to the API origin and nothing else (no extra script or
 * connect origins were added; no third-party bot widget is used).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { BRAND_API_URL } from '../../packages/shared/src/brand';
import { ContactPage } from '../../apps/marketing/src/components/ContactPage';
import { AboutPage } from '../../apps/marketing/src/components/AboutPage';

const MK = path.resolve(__dirname, '../../apps/marketing');

describe('/contact renders the form in both locales', () => {
  for (const l of ['ar', 'en'] as const) {
    it(`${l}: one h1, a form posting to the API, and the other ways to reach us`, () => {
      const html = renderToStaticMarkup(<ContactPage locale={l} />);
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toContain(`action="${BRAND_API_URL}/api/v1/public/contact/enquiry"`);
      expect(html).toContain('name="website"');
      expect(html).toContain('mailto:ahlan@ebda.app');
    });
  }
  it('Arabic uses Egyptian copy and English is English', () => {
    expect(renderToStaticMarkup(<ContactPage locale="ar" />)).toContain('هنرد عليك خلال يوم عمل');
    expect(renderToStaticMarkup(<ContactPage locale="en" />)).toContain('within one working day');
  });
  it('About CTA goes to the contact page', () => {
    expect(renderToStaticMarkup(<AboutPage locale="ar" />)).toContain('href="/contact"');
    expect(renderToStaticMarkup(<AboutPage locale="en" />)).toContain('href="/en/contact"');
  });
});

describe('marketing CSP (public/_headers)', () => {
  const headers = readFileSync(path.join(MK, 'public/_headers'), 'utf8');
  const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)![1];
  const dir = (n: string) =>
    csp
      .split(';')
      .map(s => s.trim())
      .find(s => s.startsWith(`${n} `));

  it('keeps frame-ancestors none and lets forms post to self + the API origin only', () => {
    expect(dir('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(dir('form-action')).toBe(`form-action 'self' ${BRAND_API_URL}`);
  });
  it('does not widen script, connect or frame sources for the form', () => {
    for (const d of ['script-src', 'connect-src', 'frame-src', 'default-src'])
      expect(dir(d), d).toBeUndefined();
    expect(csp).not.toMatch(/\*|unsafe-|turnstile|challenges\./i);
  });
  it('the form does not load any third-party script', () => {
    const src = readFileSync(path.join(MK, 'src/components/ContactForm.tsx'), 'utf8');
    expect(src).not.toMatch(/<script|turnstile|recaptcha|hcaptcha/i);
    expect(src).toContain('CONTACT_HONEYPOT_FIELD');
  });
});
