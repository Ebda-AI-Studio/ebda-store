'use client';

import React from 'react';
import {
  Sparkles,
  Search,
  CreditCard,
  Calculator,
  MessageCircle,
  Palette,
  type LucideIcon,
} from 'lucide-react';
import { SectionHeader } from '@/components/landing/SectionHeader';
import { Aurora } from '@/components/landing/Reveal';
import { useLanguage } from '@/contexts/LanguageContext';

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
  /** Featured tile spans 2 columns / 2 rows of the bento grid on large screens. */
  featured?: boolean;
}

/**
 * Features — a scannable bento grid of what the platform does.
 *
 * Replaces the earlier full-screen radial-orbital timeline: a marketing
 * landing needs the capabilities readable at a glance, not hidden behind a
 * rotating, click-to-expand orbit. The AI flagship takes the large bento
 * tile; the rest pack around it.
 *
 * Deliberately does NOT repeat AEO/GEO here — `AeoGeoSection` owns that
 * deep-dive, so the two sections stay complementary instead of redundant.
 * Card idiom (glass surface + orange icon chip + hover lift/glow) matches
 * AeoGeoSection so the page reads as one system.
 */
export default function FeaturesSection() {
  const { t } = useLanguage();

  const features: Feature[] = [
    {
      icon: Sparkles,
      featured: true,
      title: t('AI autofill — Arabic & English', 'ملء تلقائي بالذكاء الاصطناعي — عربي وإنجليزي'),
      body: t(
        'Upload a photo or type a few words and the platform writes product names, descriptions, and SEO copy in Arabic and English at once — bidirectional, Arabic-first, and ready to publish in seconds. No copywriter, no translator, no blank fields.',
        'ارفع صورة أو اكتب بضع كلمات وتكتب المنصة أسماء المنتجات والأوصاف ونصوص SEO بالعربية والإنجليزية معاً — ثنائي الاتجاه، عربي أولاً، وجاهز للنشر في ثوانٍ. لا كاتب محتوى ولا مترجم ولا حقول فارغة.'
      ),
    },
    {
      icon: Search,
      title: t('SEO that writes itself', 'SEO يكتب نفسه'),
      body: t(
        'Per-product meta titles, alt text, canonical tags, sitemaps, and Arabic/English hreflang are generated and kept fresh automatically — no plugin, no developer.',
        'عناوين ميتا لكل منتج ونص بديل وعلامات canonical وخرائط موقع وhreflang للعربية والإنجليزية تُولَّد وتُحدَّث تلقائياً — لا إضافات ولا مطوّر.'
      ),
    },
    {
      icon: CreditCard,
      title: t('Kuwait payments, connected', 'مدفوعات الكويت، موصولة'),
      body: t(
        'Tap, MyFatoorah, Hesabe, and UPayments are wired in out of the box — KNET and cards work on day one, with KWD as the first-class currency and no external checkout redirects.',
        'Tap وMyFatoorah وHesabe وUPayments مدمجة من اليوم الأول — KNET والبطاقات تعمل فوراً، والدينار الكويتي هو العملة الرئيسية دون تحويل إلى صفحات دفع خارجية.'
      ),
    },
    {
      icon: Calculator,
      title: t('Accounting & inventory built in', 'محاسبة ومخزون مدمجان'),
      body: t(
        'Double-entry books, real-time stock, P&L, tax reports, and multi-warehouse routing live inside your store — no spreadsheets, no external ERP, no manual reconciliation.',
        'دفاتر القيد المزدوج والمخزون اللحظي والأرباح والخسائر والتقارير الضريبية وتوزيع المستودعات داخل متجرك — لا جداول بيانات ولا ERP خارجي ولا تسوية يدوية.'
      ),
    },
    {
      icon: MessageCircle,
      title: t('WhatsApp catalog & broadcasts', 'كتالوج واتساب والبث'),
      body: t(
        'Your live catalog syncs to a native WhatsApp catalog automatically, and you broadcast targeted offers to customer segments — all from the dashboard you manage orders on.',
        'يتزامن كتالوجك الحي مع كتالوج WhatsApp الأصلي تلقائياً، وتبث عروضاً مستهدفة لشرائح العملاء — كل ذلك من لوحة التحكم التي تدير منها طلباتك.'
      ),
    },
    {
      icon: Palette,
      title: t('Smart customization', 'تخصيص ذكي'),
      body: t(
        'A Smart Palette builds a full brand color system from one color pick, and a page builder tunes every section, font, and layout to your brand in seconds — no code, no designer.',
        'تبني اللوحة الذكية نظام ألوان متكاملاً من لون واحد، ومنشئ الصفحات يضبط كل قسم وخط وتخطيط لهويتك في ثوانٍ — دون كود ودون مصمم.'
      ),
    },
  ];

  return (
    <section id="features" className="relative w-full overflow-hidden bg-black py-20 md:py-28">
      <Aurora />
      <div className="relative z-10 mx-auto max-w-6xl px-4">
        <SectionHeader
          kicker={t('AI-NATIVE COMMERCE', 'تجارة ذكاء اصطناعي أصيلة')}
          title={t('Your store, run by AI', 'متجرك، يُديره الذكاء الاصطناعي')}
          subtitle={t(
            'Writing, search visibility, accounting, payments, and WhatsApp — everything a Kuwaiti merchant needs, in one place.',
            'الكتابة والظهور في البحث والمحاسبة والمدفوعات وواتساب — كل ما يحتاجه التاجر الكويتي في مكان واحد.'
          )}
        />

        {/* Bento grid — the flagship AI tile spans 2 cols / 2 rows on large
            screens; the rest pack around it. Collapses to a 2-col / 1-col
            stack on smaller screens so nothing is cramped. */}
        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, body, featured }) => (
            <article
              key={title}
              className={[
                'group flex flex-col rounded-2xl border border-white/10 bg-white/[0.04] p-7 backdrop-blur',
                'transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-[0_8px_40px_rgba(255,110,1,0.15)]',
                featured
                  ? 'sm:col-span-2 lg:row-span-2 bg-gradient-to-br from-primary/[0.10] to-white/[0.03] lg:p-9'
                  : '',
              ].join(' ')}
            >
              <span
                className={[
                  'inline-flex items-center justify-center rounded-xl bg-primary/15 text-primary',
                  featured ? 'h-14 w-14' : 'h-12 w-12',
                ].join(' ')}
              >
                <Icon className={featured ? 'h-7 w-7' : 'h-6 w-6'} />
              </span>
              <h3
                className={[
                  'font-bold text-white',
                  featured ? 'mt-6 text-2xl md:text-3xl' : 'mt-5 text-xl',
                ].join(' ')}
              >
                {title}
              </h3>
              <p
                className={[
                  'leading-relaxed text-white/90',
                  featured ? 'mt-4 text-base md:text-lg' : 'mt-3 text-base',
                ].join(' ')}
              >
                {body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
