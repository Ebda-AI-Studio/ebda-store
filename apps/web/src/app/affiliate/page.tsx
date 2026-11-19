'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useStore } from '../../contexts/StoreContext';
import { ShopChrome } from '../../components';
import { useFeatures } from '../../contexts/FeatureContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { demoRefusalText } from '../../lib/demo-refusal';
import { API_URL } from '../../lib/api';

import { REGION } from '@ebda/shared';
import { pickLocalizedName } from '../../templates/shared/display-helpers';
// ==========================================
// Referral Tracking (run once per session)
// ==========================================

function useReferralTracking() {
  const { store } = useStore();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!store?.id || store.id === 'demo') return;

    const ref = searchParams?.get('ref');
    if (!ref) return;

    // Only track once per session — check cookie
    const cookieName = `affiliate_ref`;
    const existing = document.cookie
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith(`${cookieName}=`));

    if (existing) return; // Already tracked this session

    // Set cookie (30 days)
    const expires = new Date();
    expires.setDate(expires.getDate() + 30);
    const secure = window.location.protocol === 'https:' ? '; Secure' : ''; // ZAP 10011
    document.cookie = `${cookieName}=${encodeURIComponent(ref)}; expires=${expires.toUTCString()}; path=/; SameSite=Lax${secure}`;

    // Register click with API (fire-and-forget)
    fetch(`${API_URL}/public/${store.id}/affiliates/track?ref=${encodeURIComponent(ref)}`, {
      method: 'GET',
    }).catch(() => {
      // Silently ignore tracking errors — don't break the page
    });
  }, [store?.id, searchParams]);
}

// ==========================================
// Affiliate Signup Page
// ==========================================

interface FormData {
  name: string;
  email: string;
  phone: string;
  instagram: string;
  tiktok: string;
}

const EMPTY_FORM: FormData = {
  name: '',
  email: '',
  phone: '',
  instagram: '',
  tiktok: '',
};

function AffiliatePageContent() {
  const { store } = useStore();
  const { isEnabled } = useFeatures();
  const { t } = useLanguage();
  const storeId = store?.id;

  useReferralTracking();

  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const affiliateEnabled = isEnabled('affiliate');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storeId || storeId === 'demo') return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/public/${storeId}/affiliates/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || undefined,
          instagram: form.instagram.trim() || undefined,
          tiktok: form.tiktok.trim() || undefined,
        }),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        const msg =
          demoRefusalText(json?.error, t) ||
          json?.error?.message ||
          t('Something went wrong. Please try again.', 'حصل خطأ. جرّب تاني.');
        setError(msg);
      } else {
        setSuccess(true);
        setForm(EMPTY_FORM);
      }
    } catch {
      setError(
        t(
          'Network error. Please check your connection and try again.',
          'مشكلة في الشبكة. اتأكد من اتصالك وجرّب تاني.'
        )
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Feature not enabled
  if (!affiliateEnabled) {
    return (
      <ShopChrome>
        <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4">
          <div className="max-w-md w-full text-center">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-foreground mb-2">
              {t('Affiliate Program Unavailable', 'برنامج الشراكة غير متاح')}
            </h1>
            <p className="text-muted-foreground">
              {t(
                'The affiliate program is not currently available for this store.',
                'برنامج الشراكة مش متاح للمتجر ده دلوقتي.'
              )}
            </p>
          </div>
        </div>
      </ShopChrome>
    );
  }

  return (
    <ShopChrome>
      <div className="bg-background py-12 px-4">
        <div className="max-w-lg mx-auto">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-primary"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-foreground mb-2">
              {t('Join Our Affiliate Program', 'انضم إلى برنامج الشراكة')}
            </h1>
            <p className="text-muted-foreground">
              {t(
                `Partner with ${store?.name || 'us'} and earn commissions for every sale you refer.`,
                pickLocalizedName(store, true)
                  ? `خليك شريك مع ${pickLocalizedName(store, true)} واكسب عمولة على كل بيعة تجيبها.`
                  : 'اشترك معانا في برنامج الشراكة واكسب عمولة على كل بيعة تجيبها.'
              )}
            </p>
          </div>

          {/* Success State */}
          {success ? (
            <div className="bg-success/10 border border-success/30 rounded-xl p-8 text-center">
              <div className="w-12 h-12 bg-success/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg
                  className="w-6 h-6 text-success-ink"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-success-ink mb-2">
                {t('Application Submitted!', 'الطلب اتبعت!')}
              </h2>
              <p className="text-success-ink">
                {t(
                  "We'll review it shortly and get back to you via email.",
                  'هنراجعه قريب ونرد عليك على البريد الإلكتروني.'
                )}
              </p>
            </div>
          ) : (
            /* Signup Form */
            <div className="bg-card rounded-xl border border-border shadow-sm p-8">
              {error && (
                <div className="mb-4 p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive-ink">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-foreground mb-1">
                    {t('Full Name', 'الاسم الكامل')} <span className="text-destructive-ink">*</span>
                  </label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    value={form.name}
                    onChange={handleChange}
                    placeholder={t('Your full name', 'اسمك الكامل')}
                    required
                    className="w-full px-4 py-2.5 border border-input rounded-lg bg-background text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                  />
                </div>

                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-foreground mb-1">
                    {t('Email Address', 'البريد الإلكتروني')}{' '}
                    <span className="text-destructive-ink">*</span>
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    value={form.email}
                    onChange={handleChange}
                    placeholder="you@example.com"
                    required
                    className="w-full px-4 py-2.5 border border-input rounded-lg bg-background text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                  />
                </div>

                <div>
                  <label htmlFor="phone" className="block text-sm font-medium text-foreground mb-1">
                    {t('Phone Number', 'رقم الموبايل')}
                  </label>
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    id="phone"
                    name="phone"
                    value={form.phone}
                    onChange={handleChange}
                    placeholder={REGION.phone.placeholderIntl}
                    className="w-full px-4 py-2.5 border border-input rounded-lg bg-background text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                  />
                </div>

                <div>
                  <label
                    htmlFor="instagram"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {t('Instagram Handle', 'حساب إنستغرام')}
                  </label>
                  <div className="relative">
                    <span className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                      @
                    </span>
                    <input
                      id="instagram"
                      name="instagram"
                      type="text"
                      value={form.instagram}
                      onChange={handleChange}
                      placeholder={t('yourhandle', 'حسابك')}
                      className="w-full ps-8 pe-4 py-2.5 border border-input rounded-lg bg-background text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="tiktok"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {t('TikTok Handle', 'حساب تيك توك')}
                  </label>
                  <div className="relative">
                    <span className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                      @
                    </span>
                    <input
                      id="tiktok"
                      name="tiktok"
                      type="text"
                      value={form.tiktok}
                      onChange={handleChange}
                      placeholder={t('yourhandle', 'حسابك')}
                      className="w-full ps-8 pe-4 py-2.5 border border-input rounded-lg bg-background text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-3 px-6 bg-primary text-primary-foreground font-semibold rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2 mt-2"
                >
                  {submitting && (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
                  )}
                  {submitting ? t('Submitting...', 'بنبعت...') : t('Apply Now', 'قدّم الآن')}
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </ShopChrome>
  );
}

export default function AffiliatePage() {
  return (
    <Suspense
      fallback={
        <ShopChrome>
          <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        </ShopChrome>
      }
    >
      <AffiliatePageContent />
    </Suspense>
  );
}
