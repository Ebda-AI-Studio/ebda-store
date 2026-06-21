'use client';

import { ArrowRight } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { SectionHeader } from '@/components/landing/SectionHeader';
import { Aurora } from '@/components/landing/Reveal';

/**
 * Before → After: a blank starter store (CSS wireframe) transforms into a real,
 * fully-branded storefront (an actual screenshot of a live merchant, Pecannbee).
 * The "after" is genuine — proof, not a mockup.
 */

/** A grey wireframe standing in for an empty / unbranded starting store. */
function BlankStoreWireframe() {
  return (
    <div className="h-full w-full bg-neutral-900 p-4">
      {/* fake top bar */}
      <div className="mb-4 flex items-center justify-between">
        <div className="h-4 w-20 rounded bg-neutral-700" />
        <div className="flex gap-2">
          <div className="h-4 w-4 rounded-full bg-neutral-700" />
          <div className="h-4 w-4 rounded-full bg-neutral-700" />
          <div className="h-4 w-4 rounded-full bg-neutral-700" />
        </div>
      </div>
      {/* fake hero */}
      <div className="mb-4 h-28 w-full rounded-lg bg-neutral-800" />
      {/* fake product grid */}
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="aspect-square w-full rounded-lg bg-neutral-800" />
            <div className="h-2.5 w-3/4 rounded bg-neutral-700" />
            <div className="h-2.5 w-1/2 rounded bg-neutral-700" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A minimal browser chrome frame around the screenshot. */
function BrowserFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-neutral-950 shadow-2xl">
      <div className="flex items-center gap-1.5 border-b border-border/40 bg-neutral-900 px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-white/25" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
      </div>
      {children}
    </div>
  );
}

export function BeforeAfterSection() {
  const { t } = useLanguage();
  return (
    <section id="before-after" className="relative overflow-hidden bg-black px-4 py-20 md:py-28">
      <Aurora />
      <div className="relative z-10 mx-auto max-w-6xl">
        <SectionHeader
          kicker={t('FROM ZERO TO LIVE', 'من الصفر إلى الإطلاق')}
          title={t('A blank page becomes your store', 'صفحة فارغة تتحوّل إلى متجرك')}
          subtitle={t(
            'Send us your products. We take it from there — a fully branded, bilingual store with payments wired in, live in days.',
            'أرسل لنا منتجاتك ونتولّى الباقي — متجر بهويتك بالعربي والإنجليزي ومدفوعات جاهزة، تنطلق خلال أيام.'
          )}
          className="mb-14"
        />

        <div className="flex flex-col items-stretch gap-6 md:flex-row md:items-center">
          {/* Before */}
          <div className="flex-1">
            <p className="mb-3 text-center text-xs font-semibold uppercase tracking-[0.2em] text-white/40">
              {t('Before', 'قبل')}
            </p>
            <BrowserFrame>
              <div className="aspect-[4/3] w-full">
                <BlankStoreWireframe />
              </div>
            </BrowserFrame>
          </div>

          {/* Arrow */}
          <div className="flex shrink-0 items-center justify-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
              <ArrowRight className="h-6 w-6 rtl:rotate-180" />
            </span>
          </div>

          {/* After — a real live store */}
          <div className="flex-1">
            <p className="mb-3 text-center text-xs font-semibold uppercase tracking-[0.2em] text-primary">
              {t('After · a live store', 'بعد · متجر حقيقي')}
            </p>
            <BrowserFrame>
              <div className="aspect-[4/3] w-full overflow-hidden">
                <img
                  src="/landing/after-store.jpg"
                  alt={t('A live branded storefront', 'متجر حقيقي بهوية كاملة')}
                  className="h-full w-full object-cover object-top"
                  loading="lazy"
                  decoding="async"
                />
              </div>
            </BrowserFrame>
          </div>
        </div>
      </div>
    </section>
  );
}
