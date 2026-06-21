'use client';

import React from 'react';
import {
  Sparkles,
  Bot,
  Globe,
  Search,
  CreditCard,
  Calculator,
  MessageCircle,
  Palette,
} from 'lucide-react';
import RadialOrbitalTimeline, { type TimelineItem } from '@/components/ui/radial-orbital-timeline';
import { SectionHeader } from '@/components/landing/SectionHeader';
import { useLanguage } from '@/contexts/LanguageContext';

export default function FeaturesSection() {
  const { t } = useLanguage();

  const featureData: TimelineItem[] = [
    {
      id: 1,
      title: t('AI Autofill — AR & EN', 'ملء تلقائي بالذكاء الاصطناعي — عربي وإنجليزي'),
      date: 'AI',
      content: t(
        'Upload a photo or type a few words and the platform writes product names, descriptions, and SEO copy in Arabic and English simultaneously — bidirectional, Arabic-first, and ready to publish in seconds.',
        'ارفع صورة أو اكتب بضع كلمات وستكتب المنصة أسماء المنتجات والأوصاف ونصوص SEO بالعربية والإنجليزية في آنٍ واحد — ثنائي الاتجاه، عربي أولاً، وجاهز للنشر في ثوانٍ.'
      ),
      category: 'Artificial Intelligence',
      icon: Sparkles,
      relatedIds: [2, 3, 4],
      status: 'completed',
      energy: 100,
    },
    {
      id: 2,
      title: t('AEO — Answer Engine Optimization', 'AEO — تحسين محركات الإجابة'),
      date: 'AI',
      content: t(
        'Your catalog is structured with question-answer schema so ChatGPT, Gemini, and Perplexity recommend your products when shoppers ask AI what to buy — your store becomes the answer, not a search result.',
        'يُهيَّأ كتالوجك بمخطط أسئلة وأجوبة لتوصي ChatGPT وGemini وPerplexity بمنتجاتك عندما يسأل المتسوقون الذكاء الاصطناعي عمّا يشترون — يصبح متجرك هو الإجابة لا مجرد نتيجة بحث.'
      ),
      category: 'Artificial Intelligence',
      icon: Bot,
      relatedIds: [1, 3, 4],
      status: 'completed',
      energy: 92,
    },
    {
      id: 3,
      title: t('GEO — Generative Engine Optimization', 'GEO — تحسين المحركات التوليدية'),
      date: 'AI',
      content: t(
        'Auto-publishes llms.txt, citation-ready copy, and structured data so generative search engines cite your store as a primary source — your brand gets quoted, not buried under aggregators.',
        'ينشر تلقائياً ملف llms.txt ونصوصاً جاهزة للاقتباس وبيانات منظّمة لتستشهد محركات البحث التوليدية بمتجرك كمصدر رئيسي — علامتك تُستشهد بها لا تُطمر تحت المجمّعات.'
      ),
      category: 'Artificial Intelligence',
      icon: Globe,
      relatedIds: [1, 2, 4],
      status: 'completed',
      energy: 88,
    },
    {
      id: 4,
      title: t('SEO that writes itself', 'SEO يكتب نفسه'),
      date: 'AI',
      content: t(
        'Per-product meta titles, alt text, canonical tags, sitemaps, and hreflang for Arabic and English are generated and kept fresh automatically — no plugin, no manual updates, no developer needed.',
        'عناوين ميتا لكل منتج ونص بديل وعلامات canonical وخرائط موقع وhreflang للعربية والإنجليزية تُولَّد وتُحدَّث تلقائياً — لا إضافات ولا تحديثات يدوية ولا مطوّر مطلوب.'
      ),
      category: 'Artificial Intelligence',
      icon: Search,
      relatedIds: [1, 2, 3],
      status: 'completed',
      energy: 85,
    },
    {
      id: 5,
      title: t('Kuwait payments, connected', 'مدفوعات الكويت، موصولة'),
      date: 'Payments',
      content: t(
        'Tap, MyFatoorah, Hesabe, and UPayments are wired in out of the box — KNET and cards work on day one, with KWD as the first-class currency and no third-party checkout redirects.',
        'Tap وMyFatoorah وHesabe وUPayments مدمجة من اليوم الأول — KNET والبطاقات تعمل فوراً، والدينار الكويتي هو العملة الرئيسية دون أي تحويل إلى صفحات دفع خارجية.'
      ),
      category: 'Payments',
      icon: CreditCard,
      relatedIds: [6, 7],
      status: 'completed',
      energy: 80,
    },
    {
      id: 6,
      title: t('Accounting & inventory', 'المحاسبة والمخزون'),
      date: 'Ops',
      content: t(
        'Double-entry books, real-time stock levels, P&L, tax reports, and multi-warehouse routing are built directly into your store — no spreadsheets, no external ERP, no manual reconciliation.',
        'دفاتر القيد المزدوج ومستويات المخزون اللحظية والأرباح والخسائر والتقارير الضريبية وتوزيع المستودعات المتعددة مدمجة في متجرك مباشرةً — لا جداول بيانات ولا ERP خارجي ولا تسوية يدوية.'
      ),
      category: 'Operations',
      icon: Calculator,
      relatedIds: [5, 7],
      status: 'completed',
      energy: 78,
    },
    {
      id: 7,
      title: t('WhatsApp catalog & broadcasts', 'كتالوج واتساب والبث'),
      date: 'Marketing',
      content: t(
        'Your live product catalog syncs to a native WhatsApp catalog automatically, and you can broadcast targeted offers to customer segments — all from the same dashboard you manage orders on.',
        'يتزامن كتالوج منتجاتك الحي مع كتالوج WhatsApp الأصلي تلقائياً، ويمكنك بث عروض مستهدفة لشرائح العملاء — كل ذلك من لوحة التحكم ذاتها التي تدير منها طلباتك.'
      ),
      category: 'Marketing',
      icon: MessageCircle,
      relatedIds: [5, 6],
      status: 'in-progress',
      energy: 70,
    },
    {
      id: 8,
      title: t('Smart customization', 'تخصيص ذكي'),
      date: 'Design',
      content: t(
        'A Smart Palette generates a full brand color system from a single color pick, and a page builder lets you tune every section, font, and layout to your brand in seconds — no code, no designer.',
        'تولّد اللوحة الذكية نظام ألوان متكاملاً لعلامتك من لون واحد تختاره، ومنشئ الصفحات يتيح لك ضبط كل قسم وخط وتخطيط ليناسب هويتك في ثوانٍ — دون كود ودون مصمم.'
      ),
      category: 'Design',
      icon: Palette,
      relatedIds: [5, 6],
      status: 'completed',
      energy: 82,
    },
  ];

  return (
    <section id="features" className="w-full bg-black py-20 md:py-28">
      {/* Section heading */}
      <div className="px-4">
        <SectionHeader
          kicker={t('AI-NATIVE COMMERCE', 'تجارة ذكاء اصطناعي أصيلة')}
          title={t('Your store, run by AI', 'متجرك، يُديره الذكاء الاصطناعي')}
          subtitle={t(
            'Writing, search visibility, accounting, payments, and WhatsApp — everything a Kuwaiti merchant needs, in one place.',
            'الكتابة والظهور في البحث والمحاسبة والمدفوعات وواتساب — كل ما يحتاجه التاجر الكويتي في مكان واحد.'
          )}
        />
      </div>

      {/* Orbital timeline */}
      <RadialOrbitalTimeline timelineData={featureData} />
    </section>
  );
}
