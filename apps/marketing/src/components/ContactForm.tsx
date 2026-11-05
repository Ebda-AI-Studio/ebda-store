'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { BRAND, BRAND_API_URL } from '@ebda/shared/brand';
import {
  CONTACT_HONEYPOT_FIELD,
  CONTACT_LIMITS,
  CONTACT_TOPIC_IDS,
  CONTACT_TOPIC_LABELS,
  normalizeEmail,
  normalizePhone,
  type ContactFieldError,
  type ContactTopicId,
} from '@ebda/shared/contact-enquiry';
import { CONTACT_FORM_COPY } from '../lib/contact-form-copy';
import { pagePath, type Locale } from '../lib/site';

/** Where the form posts (the API's public prefix). It is also the `action`, so the form works without JavaScript. */
export const CONTACT_ENDPOINT = `${BRAND_API_URL}/api/v1/public/contact/enquiry`;

type Field = 'name' | 'company' | 'phone' | 'email' | 'topic' | 'message' | 'consent';
type Errors = Partial<Record<Field, ContactFieldError>>;
type Status = 'idle' | 'sending' | 'sent';

const REQUIRED_ORDER: Field[] = ['name', 'phone', 'email', 'topic', 'message', 'consent'];

/** The same rules the API enforces, so most mistakes are caught before a request is made. */
function validate(v: Record<Field, string | boolean>): Errors {
  const e: Errors = {};
  const s = (k: Field) => String(v[k] ?? '').trim();
  if (!s('name')) e.name = 'required';
  else if (s('name').length > CONTACT_LIMITS.name) e.name = 'too_long';
  if (s('company').length > CONTACT_LIMITS.company) e.company = 'too_long';
  if (!s('phone')) e.phone = 'required';
  else if (!normalizePhone(s('phone'))) e.phone = 'invalid_phone';
  if (!s('email')) e.email = 'required';
  else if (!normalizeEmail(s('email'))) e.email = 'invalid_email';
  if (!s('topic')) e.topic = 'required';
  else if (!(CONTACT_TOPIC_IDS as readonly string[]).includes(s('topic')))
    e.topic = 'invalid_topic';
  if (!s('message')) e.message = 'required';
  else if (s('message').length < CONTACT_LIMITS.messageMin) e.message = 'too_short';
  else if (s('message').length > CONTACT_LIMITS.message) e.message = 'too_long';
  if (!v.consent) e.consent = 'consent_required';
  return e;
}

/**
 * The studio enquiry form. A real `<form method="post" action=API>`: without JavaScript the browser posts it and the
 * API redirects back to `/contact/#sent` or `#send-failed` (static panels shown with `:target`). With JavaScript it
 * validates, posts JSON, and shows the result in place (role=status), moving focus to the first error or the result.
 */
export function ContactForm({ locale }: { locale: Locale }) {
  const f = CONTACT_FORM_COPY[locale];
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const formRef = useRef<HTMLFormElement>(null);
  const sentRef = useRef<HTMLHeadingElement>(null);
  const openedAt = useRef<number>(0);
  const [hydrated, setHydrated] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [status, setStatus] = useState<Status>('idle');
  const [banner, setBanner] = useState('');

  useEffect(() => {
    openedAt.current = Date.now();
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (status === 'sent') sentRef.current?.focus();
  }, [status]);

  const label = (t: ContactTopicId) => CONTACT_TOPIC_LABELS[t][locale];
  const support: readonly ContactTopicId[] = CONTACT_TOPIC_IDS.filter(
    t => t === 'store-support' || t === 'chat-support'
  );
  const services = CONTACT_TOPIC_IDS.filter(t => !support.includes(t) && t !== 'other');

  function focusFirst(e: Errors) {
    const first = REQUIRED_ORDER.concat(['company']).find(k => e[k]);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
  }

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (status === 'sending') return;
    const fd = new FormData(ev.currentTarget);
    const values = Object.fromEntries(fd.entries()) as Record<string, string>;
    const local = validate({ ...values, consent: values.consent === 'on' } as Record<
      Field,
      string | boolean
    >);
    setBanner('');
    setErrors(local);
    if (Object.keys(local).length) {
      focusFirst(local);
      return;
    }
    setStatus('sending');
    try {
      const res = await fetch(CONTACT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name: values.name,
          company: values.company,
          phone: values.phone,
          email: values.email,
          topic: values.topic,
          message: values.message,
          consent: true,
          lang: locale,
          [CONTACT_HONEYPOT_FIELD]: values[CONTACT_HONEYPOT_FIELD] ?? '',
          fillMs: Date.now() - openedAt.current,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: { code?: string; fields?: Errors };
      } | null;
      if (res.ok && body?.success) {
        setStatus('sent');
        return;
      }
      setStatus('idle');
      const code = body?.error?.code;
      if (code === 'VALIDATION_ERROR' && body?.error?.fields) {
        setErrors(body.error.fields);
        focusFirst(body.error.fields);
      } else {
        setBanner(code === 'TOO_FAST' ? f.tooFast : res.status === 429 ? f.rateLimited : f.failed);
      }
    } catch {
      setStatus('idle');
      setBanner(f.failed);
    }
  }

  const errKeys = (Object.keys(errors) as Field[]).filter(k => errors[k]);
  const fieldProps = (k: Field) => ({
    name: k,
    id: id(k),
    'aria-invalid': errors[k] ? (true as const) : undefined,
    'aria-describedby':
      [errors[k] ? id(`${k}-err`) : '', k === 'phone' ? id('phone-hint') : '']
        .filter(Boolean)
        .join(' ') || undefined,
  });
  const err = (k: Field) =>
    errors[k] ? (
      <p className="cf-err" id={id(`${k}-err`)}>
        {f.errors[errors[k]!]}
      </p>
    ) : null;

  return (
    <div className="cf" id="form">
      {/* Static panels the API redirect lands on when the page was posted without JavaScript. */}
      <section className="cf-flag cf-flag-ok" id="sent" role="status">
        <h3>{f.sentH}</h3>
        <p>{f.sentP}</p>
      </section>
      <section className="cf-flag cf-flag-bad" id="send-failed" role="alert">
        <p>{f.failed}</p>
      </section>

      {/* Always present so assistive tech announces its content when it changes. */}
      <div role="status" aria-live="polite" className={status === 'sent' ? 'cf-sent' : 'cf-sr'}>
        {status === 'sent' ? (
          <>
            <h3 ref={sentRef} tabIndex={-1}>
              {f.sentH}
            </h3>
            <p>{f.sentP}</p>
          </>
        ) : null}
      </div>

      {status !== 'sent' ? (
        <form
          ref={formRef}
          className="cf-form"
          method="post"
          action={CONTACT_ENDPOINT}
          noValidate={hydrated}
          onSubmit={onSubmit}
          lang={locale}
        >
          <input type="hidden" name="lang" value={locale} />
          {banner ? (
            <p className="cf-banner" role="alert">
              {banner} <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>
            </p>
          ) : null}
          {errKeys.length > 0 ? (
            <div className="cf-summary" role="alert">
              <p>{f.errorSummary}</p>
              <ul>
                {errKeys.map(k => (
                  <li key={k}>
                    <a href={`#${id(k)}`}>{f.errors[errors[k]!]}</a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="cf-row">
            <label htmlFor={id('name')}>{f.name}</label>
            <input
              {...fieldProps('name')}
              type="text"
              autoComplete="name"
              required
              maxLength={CONTACT_LIMITS.name}
            />
            {err('name')}
          </div>

          <div className="cf-row">
            <label htmlFor={id('company')}>
              {f.company} <span className="cf-opt">({f.companyHint})</span>
            </label>
            <input
              {...fieldProps('company')}
              type="text"
              autoComplete="organization"
              maxLength={CONTACT_LIMITS.company}
            />
            {err('company')}
          </div>

          <div className="cf-row">
            <label htmlFor={id('phone')}>{f.phone}</label>
            <input
              {...fieldProps('phone')}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              dir="ltr"
              required
              maxLength={CONTACT_LIMITS.phone}
            />
            <p className="cf-hint" id={id('phone-hint')}>
              {f.phoneHint}
            </p>
            {err('phone')}
          </div>

          <div className="cf-row">
            <label htmlFor={id('email')}>{f.email}</label>
            <input
              {...fieldProps('email')}
              type="email"
              autoComplete="email"
              dir="ltr"
              required
              maxLength={CONTACT_LIMITS.email}
            />
            {err('email')}
          </div>

          <div className="cf-row">
            <label htmlFor={id('topic')}>{f.topic}</label>
            <select {...fieldProps('topic')} required defaultValue="">
              <option value="" disabled>
                {f.topicPlaceholder}
              </option>
              <optgroup label={f.topicSupport}>
                {support.map(t => (
                  <option key={t} value={t}>
                    {label(t)}
                  </option>
                ))}
              </optgroup>
              <optgroup label={f.topicServices}>
                {services.map(t => (
                  <option key={t} value={t}>
                    {label(t)}
                  </option>
                ))}
              </optgroup>
              <option value="other">{label('other')}</option>
            </select>
            {err('topic')}
          </div>

          <div className="cf-row">
            <label htmlFor={id('message')}>{f.message}</label>
            <textarea
              {...fieldProps('message')}
              rows={6}
              required
              minLength={CONTACT_LIMITS.messageMin}
              maxLength={CONTACT_LIMITS.message}
            />
            {err('message')}
          </div>

          {/* Honeypot: off-screen, out of the tab order, hidden from assistive tech; people never fill it. */}
          <div className="cf-hp" aria-hidden="true">
            <input type="text" name={CONTACT_HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" />
          </div>

          <div className="cf-row cf-consent">
            <input {...fieldProps('consent')} type="checkbox" required />
            <label htmlFor={id('consent')}>
              {f.consentBefore}
              <a href={pagePath(locale, 'privacy')}>{f.consentLink}</a>
              {f.consentAfter}
            </label>
            {err('consent')}
          </div>

          <button type="submit" className="btn btn-primary btn-lg" disabled={status === 'sending'}>
            {status === 'sending' ? f.sending : f.submit}
          </button>
        </form>
      ) : null}
    </div>
  );
}
