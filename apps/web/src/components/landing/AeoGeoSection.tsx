'use client';

import { Bot, Globe } from 'lucide-react';
import { SectionHeader } from '@/components/landing/SectionHeader';
import { Aurora } from '@/components/landing/Reveal';
import { useLanguage } from '@/contexts/LanguageContext';

export function AeoGeoSection() {
  const { t } = useLanguage();

  return (
    <section id="aeo-geo" className="relative overflow-hidden w-full bg-[#0b0a09] py-20 md:py-28">
      <Aurora />
      <div className="relative z-10 mx-auto max-w-5xl px-4">
        {/* Section header */}
        <SectionHeader
          kicker={t('THE AI ADVANTAGE', 'ميزة الذكاء الاصطناعي')}
          title={t(
            'Get found inside ChatGPT, Gemini & Perplexity',
            'اظهر داخل ChatGPT و Gemini و Perplexity'
          )}
          subtitle={t(
            'Shoppers ask AI what to buy. We structure your store so the answer is you.',
            'المتسوقون يسألون الذكاء الاصطناعي عمّا يشترون. نحن نهيّئ متجرك ليكون هو الجواب.'
          )}
        />

        {/* Cards grid */}
        <div className="mt-12 grid gap-6 md:grid-cols-2">
          {/* AEO card */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-8 backdrop-blur transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-[0_8px_40px_rgba(176,141,87,0.15)]">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Bot className="h-6 w-6" />
            </span>
            <h3 className="mt-5 text-xl font-bold text-white">
              {t('Answer Engine Optimization', 'تحسين محركات الإجابة')}
            </h3>
            <p className="mt-3 text-base leading-relaxed text-white">
              {t(
                'We structure your catalog, FAQs and entities so AI assistants surface and recommend your products when customers ask what to buy.',
                'نهيّئ كتالوجك وأسئلتك الشائعة وبياناتك ليقترح مساعدو الذكاء الاصطناعي منتجاتك عندما يسأل العملاء عمّا يشترون.'
              )}
            </p>
          </div>

          {/* GEO card */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-8 backdrop-blur transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-[0_8px_40px_rgba(176,141,87,0.15)]">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Globe className="h-6 w-6" />
            </span>
            <h3 className="mt-5 text-xl font-bold text-white">
              {t('Generative Engine Optimization', 'تحسين المحركات التوليدية')}
            </h3>
            <p className="mt-3 text-base leading-relaxed text-white">
              {t(
                'llms.txt, citation-ready copy and structured data so generative search engines cite your store as the trusted source — in Arabic and English.',
                'ملف llms.txt ونصوص جاهزة للاقتباس وبيانات منظّمة لتستشهد محركات البحث التوليدية بمتجرك كمصدر موثوق — بالعربية والإنجليزية.'
              )}
            </p>
          </div>
        </div>

        {/* "Optimized for" pill row */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <span className="text-sm text-white/50">{t('Optimized for', 'مُحسّن لـ')}</span>
          {['ChatGPT', 'Gemini', 'Perplexity'].map(engine => (
            <span
              key={engine}
              className="rounded-full border border-white/15 px-4 py-1 text-sm text-white/50"
            >
              {engine}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
