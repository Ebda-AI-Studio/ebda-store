'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import AnimatedTextCycle from '@/components/ui/animated-text-cycle';
import { LiquidLink } from '@/components/ui/liquid-glass-button';
import { useLanguage } from '@/contexts/LanguageContext';

// Dynamically imported so tsparticles never runs on the server.
const SparklesCore = dynamic(() => import('@/components/ui/sparkles').then(m => m.SparklesCore), {
  ssr: false,
});

const CYCLE_WORDS = ['storefront', 'catalog', 'checkout', 'brand', 'growth'];

/**
 * CtaSection
 *
 * Full-width dark section with:
 *  - SparklesCore as an absolute background layer (Force orange particles).
 *  - Radial gradient masks so the sparkles fade at the edges.
 *  - A headline with AnimatedTextCycle cycling through CYCLE_WORDS.
 *  - Liquid-glass CTA links to the real contact channels (WhatsApp / email).
 */
export default function CtaSection() {
  const { t } = useLanguage();

  return (
    <section className="relative w-full overflow-hidden bg-black px-6 py-32 sm:py-40">
      {/* ------------------------------------------------------------------ */}
      {/* Sparkles background                                                  */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          maskImage: 'radial-gradient(ellipse 80% 70% at 50% 50%, black 40%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 70% at 50% 50%, black 40%, transparent 100%)',
        }}
      >
        <SparklesCore
          id="cta-sparkles"
          className="h-full w-full"
          background="transparent"
          particleColor="#ff6e01"
          particleDensity={80}
          minSize={0.6}
          maxSize={1.6}
          speed={0.8}
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Foreground content                                                   */}
      {/* ------------------------------------------------------------------ */}
      <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-10 text-center">
        {/* Badge */}
        <span className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-4 py-1 text-sm font-medium text-primary">
          {t('Powered by Force AI', 'مدعوم من Force AI')}
        </span>

        {/* Headline */}
        <h2 className="text-4xl font-extrabold leading-tight tracking-tight text-white sm:text-5xl lg:text-6xl">
          {t('Launch your', 'أطلق')}{' '}
          <AnimatedTextCycle words={CYCLE_WORDS} interval={2800} className="text-primary" />{' '}
          {t('today', 'اليوم')}
        </h2>

        {/* Sub-copy */}
        <p className="max-w-xl text-lg text-white/60">
          {t(
            'We build and run your store — you focus on selling. One team, fully managed, Arabic-first.',
            'نبني متجرك وندير تشغيله — وأنت تركّز على البيع. فريق واحد، إدارة كاملة، عربي أولاً.'
          )}
        </p>

        {/* CTA — liquid-glass links to the real contact channels (managed model, no self-serve) */}
        <div className="flex flex-wrap items-center justify-center gap-4">
          <LiquidLink
            href="https://wa.me/96566740311"
            target="_blank"
            rel="noopener noreferrer"
            size="xl"
            className="text-white"
          >
            {t('Talk on WhatsApp', 'تواصل عبر واتساب')}
          </LiquidLink>
          <LiquidLink href="mailto:info@forcemediakw.com" size="xl" className="text-white">
            {t('Email us', 'راسلنا')}
          </LiquidLink>
        </div>

        {/* Trust line — accurate to the managed-agency model */}
        <p className="text-sm text-white/40">
          {t(
            'Managed setup · Kuwait payments built in · Live in days',
            'إعداد مُدار · مدفوعات الكويت مدمجة · انطلق في أيام'
          )}
        </p>
      </div>
    </section>
  );
}
