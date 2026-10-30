'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { Button, Input } from '@ebda/ui';
import { PublicShell } from '../../components/onboarding/PublicShell';
import { apiGet, apiPost } from '../../lib/api';
import { getEbdaTracker } from '../../lib/ebda-tracker';
import { useAuth } from '../../lib/auth';
import { validateSignup, type SignupFields } from '../../lib/onboarding-validation';
import { useT } from '@/i18n/useT';
import { LEGAL_DOC_TITLE, legalPolicyUrl, type LegalDocKey } from '@ebda/shared';
import { STATIC_PLANS } from '../../components/billing/plans';
import { isTrialPlanCode, storePlan, type PlanSelection } from '../../components/billing/types';
import { storeSignupSlug } from '../../components/onboarding/signup-slug';

/** Every document the API records at signup is shown and linked here (LEGAL_DOC_KEYS, reading order). */
const SIGNUP_LEGAL_DOCS: readonly LegalDocKey[] = [
  'terms',
  'privacy',
  'merchant',
  'acceptableUse',
  'legal',
];

export default function SignupPage() {
  const t = useT('onboarding.signup');
  const tSent = useT('onboarding.signup.sent');
  const tErr = useT('onboarding.signup.errors');
  const tPlan = useT('onboarding.signup.plan');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [fields, setFields] = useState<SignupFields>({
    name: '',
    email: '',
    phone: '',
    password: '',
  });
  const [errors, setErrors] = useState<ReturnType<typeof validateSignup>>({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  // Abuse controls: a server-signed "form loaded at" token (a submit that is
  // too fast is refused) and a honeypot input real people never see or fill.
  const [formToken, setFormToken] = useState('');
  const [honeypot, setHoneypot] = useState('');
  // Click-wrap (Ruling LEGAL-4): required; the API refuses a signup without it too.
  const [agreed, setAgreed] = useState(false);
  const [legalError, setLegalError] = useState(false);
  const legalRef = useRef<HTMLInputElement>(null);

  // The plan picked on the marketing site arrives as ?plan=<id>&interval=month|year.
  // Validate it, keep it for the onboarding plan step, and show it back.
  const [selectedPlan, setSelectedPlan] = useState<PlanSelection | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    // A store-host 404 sends ?slug=<name>: keep it (if signup would accept it) for the store step.
    storeSignupSlug(qs.get('slug'));
    const planCode = qs.get('plan');
    if (!isTrialPlanCode(planCode)) return;
    const selection: PlanSelection = {
      planCode,
      interval: qs.get('interval') === 'year' ? 'yearly' : 'monthly',
    };
    storePlan(selection);
    setSelectedPlan(selection);
  }, []);
  const selectedPlanOption = selectedPlan
    ? STATIC_PLANS.find(p => p.code === selectedPlan.planCode)
    : undefined;

  async function loadFormToken() {
    const { data } = await apiGet<{ token: string }>('/api/v1/auth/merchant/signup-token');
    setFormToken(data?.token ?? '');
  }

  useEffect(() => {
    void loadFormToken();
  }, []);

  // Someone already signed in has no use for this page.
  useEffect(() => {
    if (!authLoading && isAuthenticated) router.replace('/onboarding');
  }, [authLoading, isAuthenticated, router]);

  function set<K extends keyof SignupFields>(key: K, value: string) {
    setFields(prev => ({ ...prev, [key]: value }));
    setErrors(prev => ({ ...prev, [key]: undefined }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    const found = validateSignup(fields);
    setErrors(found);
    setLegalError(!agreed);
    if (!agreed && Object.keys(found).length === 0) legalRef.current?.focus();
    if (Object.keys(found).length > 0 || !agreed) return;

    setSubmitting(true);
    const email = fields.email.trim();
    // Ebda's own ads tracking: attribution + click ids, only when the visitor consented.
    const tracker = getEbdaTracker();
    const tracking = tracker?.signupPayload();
    const { error } = await apiPost('/api/v1/auth/merchant/signup', {
      email,
      password: fields.password,
      name: fields.name.trim(),
      phone: fields.phone.trim(),
      language: document.documentElement.dir === 'rtl' ? 'ar' : 'en',
      formToken,
      company_site: honeypot,
      acceptedLegal: true,
      ...(tracking ? { tracking } : {}),
    });
    setSubmitting(false);
    if (error) {
      if (error.code === 'EMAIL_DOMAIN_NOT_ALLOWED') {
        setErrors(prev => ({ ...prev, email: 'emailDisposable' }));
      } else if (error.code === 'SIGNUP_TOO_FAST' || error.code === 'SIGNUP_FORM_INVALID') {
        // A used / expired / too-early token: get a fresh one and ask again.
        void loadFormToken();
        setFormError(tErr(error.code === 'SIGNUP_TOO_FAST' ? 'tooFast' : 'formExpired'));
      } else if (error.code === 'VALIDATION_ERROR' && error.details) {
        setFormError(tErr('generic'));
      } else {
        setFormError(error.status === 429 ? tErr('rateLimited') : tErr('generic'));
      }
      return;
    }
    // Lead: the form was accepted (browser-only; the account is not real until verified).
    tracker?.track('signup_submitted', {
      eventId: `lead_${crypto.randomUUID()}`,
      props: { content_name: 'signup' },
    });
    setSentTo(email);
  }

  async function handleResend() {
    if (!sentTo) return;
    setResending(true);
    setResent(false);
    setFormError('');
    const { error } = await apiPost('/api/v1/auth/merchant/resend-verification', { email: sentTo });
    setResending(false);
    if (error) {
      setFormError(error.status === 429 ? tErr('rateLimited') : tErr('generic'));
      return;
    }
    setResent(true);
  }

  if (sentTo) {
    return (
      <PublicShell title={tSent('title')}>
        <p className="text-center text-sm text-muted-foreground">
          {tSent('body', { email: sentTo })}
        </p>
        <div className="mt-6 space-y-3">
          {formError && (
            <p role="alert" className="text-sm text-destructive-ink">
              {formError}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={resending}
            onClick={handleResend}
          >
            {resending ? tSent('resending') : tSent('resend')}
          </Button>
          {resent && (
            <p role="status" className="text-center text-sm text-muted-foreground">
              {tSent('resent')}
            </p>
          )}
          <p className="text-center text-sm">
            <Link href="/login" className="text-primary-ink hover:underline">
              {tSent('backToLogin')}
            </Link>
          </p>
        </div>
      </PublicShell>
    );
  }

  return (
    <PublicShell title={t('title')} subtitle={t('subtitle')}>
      {selectedPlan && selectedPlanOption && (
        <p
          data-testid="selected-plan"
          className="mb-4 rounded-lg bg-muted px-3 py-2 text-center text-sm text-foreground"
        >
          {tPlan('chip', {
            plan: locale === 'ar' ? selectedPlanOption.nameAr : selectedPlanOption.nameEn,
            interval: tPlan(selectedPlan.interval),
          })}
        </p>
      )}
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        {formError && (
          <div
            role="alert"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink"
          >
            {formError}
          </div>
        )}
        {/* Honeypot: clipped to 1px, not focusable, not announced. A bot fills it; a person never does.
            Clipped, not `left:-10000px`: in this RTL page that offset made the document 10,390px wide. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
          }}
        >
          <label htmlFor="signup-company-site">{t('companyWebsite')}</label>
          <input
            id="signup-company-site"
            name="company_site"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={e => setHoneypot(e.target.value)}
          />
        </div>
        <Input
          id="signup-name"
          name="name"
          label={t('name')}
          autoComplete="name"
          value={fields.name}
          onChange={e => set('name', e.target.value)}
          placeholder={t('namePlaceholder')}
          error={errors.name ? tErr(errors.name) : undefined}
        />
        <Input
          id="signup-email"
          name="email"
          type="email"
          dir="ltr"
          label={t('email')}
          autoComplete="email"
          value={fields.email}
          onChange={e => set('email', e.target.value)}
          placeholder={t('emailPlaceholder')}
          error={errors.email ? tErr(errors.email) : undefined}
        />
        <div>
          <Input
            id="signup-phone"
            name="phone"
            required
            type="tel"
            dir="ltr"
            inputMode="tel"
            label={t('phone')}
            autoComplete="tel-national"
            value={fields.phone}
            onChange={e => set('phone', e.target.value)}
            placeholder={t('phonePlaceholder')}
            error={errors.phone ? tErr(errors.phone) : undefined}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('phoneHelp')}</p>
        </div>
        <div>
          <Input
            id="signup-password"
            name="password"
            type="password"
            dir="ltr"
            label={t('password')}
            autoComplete="new-password"
            value={fields.password}
            onChange={e => set('password', e.target.value)}
            placeholder={t('passwordPlaceholder')}
            error={errors.password ? tErr(errors.password) : undefined}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('passwordHelp')}</p>
        </div>
        <div>
          <label htmlFor="signup-legal" className="flex items-start gap-2 text-sm text-foreground">
            <input
              id="signup-legal"
              ref={legalRef}
              name="acceptedLegal"
              type="checkbox"
              required
              checked={agreed}
              onChange={e => {
                setAgreed(e.target.checked);
                setLegalError(false);
              }}
              aria-invalid={legalError || undefined}
              aria-describedby={legalError ? 'signup-legal-error' : undefined}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              {t('legal.prefix')}
              {SIGNUP_LEGAL_DOCS.map((key, i) => (
                <Fragment key={key}>
                  {i > 0 && t(i === SIGNUP_LEGAL_DOCS.length - 1 ? 'legal.lastSep' : 'legal.sep')}
                  <a
                    href={legalPolicyUrl(key, locale)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-ink underline"
                  >
                    {LEGAL_DOC_TITLE[key][locale]}
                  </a>
                </Fragment>
              ))}
            </span>
          </label>
          {legalError && (
            <p id="signup-legal-error" role="alert" className="mt-1 text-sm text-destructive-ink">
              {tErr('legalRequired')}
            </p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? t('submitting') : t('submit')}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          {t('haveAccount')}{' '}
          <Link href="/login" className="text-primary-ink hover:underline">
            {t('signIn')}
          </Link>
        </p>
      </form>
    </PublicShell>
  );
}
