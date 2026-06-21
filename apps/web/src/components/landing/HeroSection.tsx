'use client';
import dynamic from 'next/dynamic';
import { cn } from '@/lib/utils';
import { liquidbuttonVariants } from '@/components/ui/liquid-glass-button';
import { useLanguage } from '@/contexts/LanguageContext';

// three.js must never hit the SSR bundle — lazy-load client-side only.
const WebGLShader = dynamic(
  () => import('@/components/ui/web-gl-shader').then(m => m.WebGLShader),
  { ssr: false }
);

const GLASS_STYLE: React.CSSProperties = {
  backdropFilter: 'blur(12px) url("#container-glass")',
  WebkitBackdropFilter: 'blur(12px) url("#container-glass")',
  background: 'rgba(255,255,255,0.10)',
  boxShadow: '0 4px 32px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.25)',
};

export function HeroSection() {
  const { t } = useLanguage();

  return (
    <section
      id="hero"
      className="relative min-h-screen bg-black overflow-hidden flex items-center justify-center"
    >
      {/* Full-bleed WebGL background — stays inside this section via absolute inset-0 */}
      <WebGLShader />

      {/* Foreground content — above the canvas */}
      <div className="relative z-10 flex items-center justify-center w-full px-4 py-24">
        <div className="max-w-3xl w-full rounded-2xl border border-border/40 bg-background/5 backdrop-blur-md p-10 md:p-16 flex flex-col items-center gap-6 text-center shadow-2xl">
          {/* Headline */}
          <h1 className="text-4xl md:text-7xl font-bold leading-tight tracking-tight text-white">
            {t('Build your store with', 'ابنِ متجرك مع')}{' '}
            <span className="text-primary">Force AI</span>
          </h1>

          {/* Sub-headline */}
          <p className="text-base md:text-xl text-white/70 max-w-xl leading-relaxed">
            {t(
              'AI-powered e-commerce storefronts built for Kuwait and the Gulf. Launch a fully customized online store in minutes — Arabic-first, locally integrated, always smart.',
              'متاجر إلكترونية مدعومة بالذكاء الاصطناعي، صُممت للكويت والخليج. أطلق متجرك الإلكتروني المخصص في دقائق — عربي أولاً، متكامل محلياً، وذكي دائماً.'
            )}
          </p>

          {/* CTAs */}
          <div className="mt-2 flex flex-wrap items-center justify-center gap-4">
            {/* Primary CTA — WhatsApp */}
            <a
              href="https://wa.me/96566740311"
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                liquidbuttonVariants({ size: 'lg' }),
                'bg-primary/80 border-primary/40 hover:bg-primary/90'
              )}
              style={GLASS_STYLE}
            >
              {t('Talk on WhatsApp', 'تواصل عبر واتساب')}
            </a>

            {/* Secondary CTA — Email */}
            <a
              href="mailto:info@forcemediakw.com"
              className={cn(liquidbuttonVariants({ size: 'lg' }))}
              style={GLASS_STYLE}
            >
              {t('Email us', 'راسلنا')}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
