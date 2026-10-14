'use client';
import { useLanguage } from '@/contexts/LanguageContext';
import { BrandedStoreWireframe } from '@/components/landing/BeforeAfterSection';
import { BRAND } from '@ebda/shared';

// Editorial grain — kills the flat "cheap" feel (matches the ebda.app umbrella).
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

export function HeroSection() {
  const { t } = useLanguage();

  return (
    <section
      id="hero"
      className="relative flex min-h-screen items-center overflow-hidden bg-[#0b0a09]"
    >
      {/* grain */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 opacity-[0.04]"
        style={{ backgroundImage: GRAIN }}
      />
      {/* warm orange ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -end-40 -top-40 z-0 h-[720px] w-[720px] rounded-full blur-[120px]"
        style={{ background: 'radial-gradient(circle, rgba(255,106,26,0.16), transparent 60%)' }}
      />

      <div className="relative z-10 mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-28 md:grid-cols-[0.92fr_1.08fr] md:gap-14">
        {/* Copy */}
        <div className="text-center md:text-start">
          <div className="mb-6 inline-flex items-center gap-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            <span className="h-px w-6 bg-primary" />
            {t('For Egyptian merchants', 'للتجار في مصر')}
          </div>

          <h1 className="mb-6 text-4xl font-extrabold leading-[1.03] tracking-tight text-white md:text-6xl">
            {t('Build your store with', 'ابنِ متجرك مع')}{' '}
            <span className="text-primary">{BRAND.product.nameEn}</span>
          </h1>

          <p className="mx-auto mb-9 max-w-xl text-base leading-relaxed text-white/60 md:mx-0 md:text-lg">
            {t(
              'AI-powered e-commerce storefronts built for Egypt. Launch a fully customized online store in minutes — Arabic-first, locally integrated, always smart.',
              'متاجر إلكترونية مدعومة بالذكاء الاصطناعي، صُممت لمصر. أطلق متجرك الإلكتروني المخصص في دقائق — عربي أولاً، متكامل محلياً، وذكي دائماً.'
            )}
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3 md:justify-start">
            <a
              href={`mailto:${BRAND.supportEmail}`}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.02] px-6 py-3.5 text-base font-semibold text-white transition-colors hover:border-primary"
            >
              {t('Email us', 'راسلنا')}
            </a>
          </div>
        </div>

        {/* Product frame — illustrative storefront */}
        <div className="relative">
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#100f0e] shadow-[0_40px_120px_rgba(0,0,0,0.7),0_30px_90px_rgba(255,106,26,0.13)]">
            <div className="flex items-center gap-2 border-b border-white/[0.06] bg-[#0e0d0c] px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
              <span className="flex-1 text-center text-xs text-white/30" dir="ltr">
                🔒 your-store.ebda.app
              </span>
            </div>
            <div className="aspect-[16/10] w-full">
              <BrandedStoreWireframe />
            </div>
          </div>
          <div className="absolute -bottom-4 -start-4 flex items-center gap-2.5 rounded-xl border border-white/10 bg-[#0e0d0c]/95 px-3.5 py-2.5 shadow-[0_16px_40px_rgba(0,0,0,0.5)] backdrop-blur">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/15 text-primary">
              ✦
            </span>
            <span className="text-xs leading-tight text-white/60">
              <b className="block text-white">{t('Live in days', 'انطلق في أيام')}</b>
              {t(`Built on ${BRAND.product.nameEn}`, `مبني على ${BRAND.product.nameAr}`)}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
