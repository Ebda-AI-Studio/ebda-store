'use client';

import { useState } from 'react';
import { Button, Input, Textarea, useToast } from '@ebda/ui';
import { ShopChrome } from '../../components';
import { useStore } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { demoRefusalText } from '../../lib/demo-refusal';
import { resolveAddressHref } from '../../templates/shared/display-helpers';
import { api } from '@/lib/api';
import { CONTACT_HONEYPOT_FIELD } from '@ebda/shared';

export default function ContactClient() {
  const { store } = useStore();
  const { t } = useLanguage();
  const { success, error: showError } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    subject: '',
    message: '',
    [CONTACT_HONEYPOT_FIELD]: '',
  });

  // Match the same address-link resolution the storefront footer uses, so
  // the contact page tiles open the merchant's pasted Google/Apple Maps URL
  // when set, fall back to a Maps search of the address text otherwise, and
  // render plain text when the merchant has explicitly disabled the link.
  const rawContact = (store.settings?.contact as Record<string, unknown> | undefined) ?? {};
  const addressLink: boolean =
    rawContact.addressLink === false || rawContact.addressLink === 'none' ? false : true;
  const addressUrl: string | undefined =
    typeof rawContact.addressUrl === 'string' && rawContact.addressUrl.trim()
      ? (rawContact.addressUrl as string).trim()
      : undefined;
  const addressHref = resolveAddressHref(store.address, addressUrl, addressLink);

  // Build mailto / tel hrefs — strip whitespace from the phone number so
  // dialers don't choke on the spaces merchants type into the input.
  const emailHref = store.email ? `mailto:${store.email}` : null;
  const phoneHref = store.phone ? `tel:${store.phone.replace(/\s+/g, '')}` : null;
  const linkClass = 'underline-offset-4 hover:underline hover:text-foreground transition-colors';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const result = await api.submitContact(formData);

      if (result.success) {
        success(
          t('Message sent!', 'رسالتك اتبعتت'),
          t("We'll get back to you as soon as possible.", 'هنرد عليك في أقرب وقت.')
        );
        setFormData({
          name: '',
          email: '',
          subject: '',
          message: '',
          [CONTACT_HONEYPOT_FIELD]: '',
        });
      } else {
        const demo = demoRefusalText(result.error, t);
        if (demo) showError(t('Demo store', translations['Demo store']), demo);
        else
          showError(
            t('Failed to send message', 'الرسالة متبعتتش'),
            result.error?.message || t('Please try again later.', 'جرّب تاني بعد شوية.')
          );
      }
    } catch {
      showError(
        t('Failed to send message', 'الرسالة متبعتتش'),
        t('Please try again later.', 'جرّب تاني بعد شوية.')
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ShopChrome>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-foreground">{t('Contact Us', 'اتصل بنا')}</h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              "Have a question or need help? We're here for you.",
              'عندك سؤال أو محتاج مساعدة؟ احنا هنا عشانك.'
            )}
          </p>
        </div>

        <div className="mt-12 rounded-xl border bg-card p-6 shadow-sm sm:p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
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
              <label htmlFor="contact-company-site">Company website</label>
              <input
                id="contact-company-site"
                name={CONTACT_HONEYPOT_FIELD}
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={formData[CONTACT_HONEYPOT_FIELD]}
                onChange={e =>
                  setFormData(prev => ({ ...prev, [CONTACT_HONEYPOT_FIELD]: e.target.value }))
                }
              />
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <Input
                label={t('Your Name', 'الاسم')}
                value={formData.name}
                onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                required
              />
              <Input
                label={t('Email Address', 'البريد الإلكتروني')}
                type="email"
                value={formData.email}
                onChange={e => setFormData(prev => ({ ...prev, email: e.target.value }))}
                required
              />
            </div>
            <Input
              label={t('Subject', 'الموضوع')}
              value={formData.subject}
              onChange={e => setFormData(prev => ({ ...prev, subject: e.target.value }))}
              required
            />
            <Textarea
              label={t('Message', 'الرسالة')}
              rows={5}
              value={formData.message}
              onChange={e => setFormData(prev => ({ ...prev, message: e.target.value }))}
              required
            />
            <Button type="submit" className="w-full" isLoading={isSubmitting}>
              {t('Send Message', 'إرسال رسالة')}
            </Button>
          </form>
        </div>

        {/* STORE-QA-48: a row with no value is hidden, never "Not available". */}
        <div className="mt-12 grid gap-8 sm:grid-cols-3">
          {emailHref && (
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <svg
                  className="h-6 w-6 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  />
                </svg>
              </div>
              <h3 className="mt-4 font-semibold text-foreground">
                {t('Email', translations['Email'])}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {emailHref ? (
                  <a href={emailHref} className={linkClass}>
                    {store.email}
                  </a>
                ) : (
                  t('Not available', 'غير متوفر')
                )}
              </p>
            </div>
          )}
          {phoneHref && (
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <svg
                  className="h-6 w-6 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                  />
                </svg>
              </div>
              <h3 className="mt-4 font-semibold text-foreground">
                {t('Phone', translations['Phone'])}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {phoneHref ? (
                  <a href={phoneHref} className={linkClass} dir="ltr">
                    {store.phone}
                  </a>
                ) : (
                  t('Not available', 'غير متوفر')
                )}
              </p>
            </div>
          )}
          {store.address && (
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <svg
                  className="h-6 w-6 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </div>
              <h3 className="mt-4 font-semibold text-foreground">{t('Location', 'الموقع')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {store.address ? (
                  addressHref ? (
                    <a
                      href={addressHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={linkClass}
                    >
                      {store.address}
                    </a>
                  ) : (
                    store.address
                  )
                ) : (
                  t('Not available', 'غير متوفر')
                )}
              </p>
            </div>
          )}
        </div>
      </div>
    </ShopChrome>
  );
}
