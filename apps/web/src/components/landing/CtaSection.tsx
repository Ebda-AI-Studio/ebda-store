'use client';

import AnimatedTextCycle from '@/components/ui/animated-text-cycle';
import { Aurora } from '@/components/landing/Reveal';
import { useLanguage } from '@/contexts/LanguageContext';
import { BRAND } from '@force/shared';

const CYCLE_WORDS = ['storefront', 'catalog', 'checkout', 'brand', 'growth'];

/**
 * CtaSection — editorial. Warm near-black with a subtle orange Aurora + radial
 * glow (no particle sparkles), an AnimatedTextCycle headline, and editorial
 * solid/ghost CTAs to the real contact channels (managed model, no self-serve).
 */
export default function CtaSection() {
  const { t } = useLanguage();

  return (
    <section className="relative w-full overflow-hidden bg-[#0b0a09] px-6 py-32 sm:py-40">
      <Aurora />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -z-0 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[130px]"
        style={{ background: 'radial-gradient(circle, rgba(255,106,26,0.10), transparent 62%)' }}
      />

      <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-10 text-center">
        <span className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-4 py-1 text-sm font-medium text-primary">
          {t('Ready when you are', 'جاهزون متى ما أردت')}
        </span>

        <h2 className="text-4xl font-extrabold leading-tight tracking-tight text-white sm:text-5xl lg:text-6xl">
          {t('Launch your', 'أطلق')}{' '}
          <AnimatedTextCycle words={CYCLE_WORDS} interval={2800} className="text-primary" />{' '}
          {t('today', 'اليوم')}
        </h2>

        <p className="max-w-xl text-lg text-white/60">
          {t(
            'We build and run your store — you focus on selling. One team, fully managed, Arabic-first.',
            'نبني متجرك وندير تشغيله — وأنت تركّز على البيع. فريق واحد، إدارة كاملة، عربي أولاً.'
          )}
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4">
          <a
            href={`mailto:${BRAND.supportEmail}`}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.02] px-7 py-4 text-base font-semibold text-white transition-colors hover:border-primary"
          >
            {t('Email us', 'راسلنا')}
          </a>
        </div>

        <p className="text-sm text-white/40">
          {t(
            'Managed setup · Egyptian payments built in · Live in days',
            'إعداد مُدار · مدفوعات مصرية مدمجة · انطلق في أيام'
          )}
        </p>
      </div>
    </section>
  );
}
