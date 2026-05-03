'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';

/**
 * Platform landing page for `store.forcemediakw.com` — replaces the
 * old "redirect to forcemediakw.com" behaviour with a properly
 * positioned page about the Force Store Builder service itself.
 *
 * Used in two places:
 *   1. The bare-root homepage when no merchant slug / domain resolved
 *      (`app/page.tsx` switches to this when `store.id === 'demo'`).
 *   2. The 404 page for unknown slugs (`app/not-found.tsx`), with a
 *      banner at the top calling out the not-found state.
 *
 * Self-contained chrome (header + footer) so it doesn't pick up the
 * merchant template's storefront UI when a real store can't be
 * resolved. Force Media palette + Poppins/Tajawal typography mirrors
 * the parent marketing site at forcemediakw.com.
 */

const ORANGE = '#fc6b02';
const ORANGE_DARK = '#3D1F1F';

type Lang = 'en' | 'ar';

const COPY = {
  brand: { en: 'Force AI', ar: 'فورس AI' },
  langToggle: { en: 'عربي', ar: 'English' },
  navServices: { en: 'What we do', ar: 'خدماتنا' },
  navProcess: { en: 'How it works', ar: 'خطواتنا' },
  navContact: { en: 'Contact', ar: 'تواصل معنا' },
  navStart: { en: 'Get started', ar: 'ابدأ الآن' },

  heroTitle: {
    en: 'Launch your online store in Kuwait',
    ar: 'أطلق متجرك الإلكتروني في الكويت',
  },
  heroSubtitle: {
    en: 'An e-commerce platform built for Kuwait merchants who want more than a Shopify subscription — bilingual by default, mobile PWA with iOS push, real-time operator dashboard, and a multi-tenant architecture priced for the local market.',
    ar: 'منصة تجارة إلكترونية مصممة للتجار في الكويت الذين يريدون أكثر من اشتراك Shopify — بلغتين منذ البداية، تطبيق ويب للجوال مع إشعارات iOS، لوحة تحكم لحظية للمتاجر، وبنية متعددة المتاجر بأسعار السوق المحلي.',
  },
  heroCta1: { en: 'Talk on WhatsApp', ar: 'تواصل عبر واتساب' },
  heroCta2: { en: 'Email us', ar: 'راسلنا بالبريد' },

  whySectionTitle: {
    en: 'Built for Kuwait merchants',
    ar: 'مصممة للتجار في الكويت',
  },
  whySectionSubtitle: {
    en: 'Every piece tuned for the way Kuwaiti shoppers buy and Kuwaiti merchants operate.',
    ar: 'كل التفاصيل مهيأة لطريقة شراء العملاء في الكويت وطريقة عمل التجار المحليين.',
  },

  servicesTitle: { en: 'What we do', ar: 'خدماتنا' },
  servicesSubtitle: {
    en: 'A full storefront platform end-to-end — you focus on products, we handle the rest.',
    ar: 'منصة متجر متكاملة من البداية للنهاية — أنت تركز على منتجاتك، ونحن نتولى الباقي.',
  },

  processTitle: { en: 'How it works', ar: 'كيف نعمل' },
  processSubtitle: {
    en: 'From first conversation to live store, in days not months.',
    ar: 'من أول محادثة حتى إطلاق المتجر، بأيام لا أشهر.',
  },

  integrationsTitle: { en: 'Plays well with', ar: 'يتكامل مع' },
  integrationsSubtitle: {
    en: 'Pre-wired with the providers Kuwait merchants actually use.',
    ar: 'جاهز للعمل مع مزودي الخدمات الذين يستخدمهم التجار في الكويت.',
  },

  audienceTitle: { en: 'Who this is for', ar: 'لمن هذه المنصة' },
  audienceSubtitle: {
    en: 'B2C storefronts and B2B catalogues — same codebase, different toggle.',
    ar: 'متاجر بيع للمستهلك ومتاجر بيع بالجملة — نفس المنصة، إعدادات مختلفة.',
  },

  includedTitle: { en: 'What’s included', ar: 'ما الذي يشمله الاشتراك' },
  includedSubtitle: {
    en: 'You get a working store, not a checklist.',
    ar: 'تحصل على متجر يعمل فعلياً، ليس مجرد قائمة مهام.',
  },

  marketingCalloutTitle: {
    en: 'Need marketing too?',
    ar: 'تبحث عن التسويق أيضاً؟',
  },
  marketingCalloutBody: {
    en: 'Force Media is our parent brand running full-service marketing across Kuwait, Saudi Arabia, and Qatar — strategy, content, paid ads, social, and influencer campaigns. 250+ companies trust them with their growth.',
    ar: 'فورس ميديا هي شركتنا الأم التي تقدم خدمات التسويق المتكاملة في الكويت والسعودية وقطر — استراتيجية، محتوى، إعلانات ممولة، تواصل اجتماعي، وحملات المؤثرين. أكثر من 250 شركة تثق بها في نموها.',
  },
  marketingCalloutCta: { en: 'Visit Force Media →', ar: 'زيارة فورس ميديا ←' },

  wbsCalloutTitle: {
    en: 'Already have a list of customers?',
    ar: 'لديك قائمة عملاء جاهزة؟',
  },
  wbsCalloutBody: {
    en: 'Force Bulk WhatsApp is our sister product for sending personalised WhatsApp campaigns to hundreds or thousands of contacts at once — order updates, promo blasts, abandoned-cart recovery. Bundle it with your store and we’ll wire your customer list into it on day one.',
    ar: 'Force Bulk WhatsApp هو منتجنا الشقيق لإرسال حملات واتساب مخصصة لمئات أو آلاف العملاء دفعة واحدة — تحديثات الطلبات، عروض ترويجية، استرجاع السلات المتروكة. اشترك معه مع متجرك ونربط قائمة عملائك من اليوم الأول.',
  },
  wbsCalloutCta: { en: 'Ask about the bundle', ar: 'اسأل عن الباقة المشتركة' },

  contactTitle: { en: 'Get in touch', ar: 'تواصل معنا' },
  contactSubtitle: {
    en: 'Tell us about your products, your timeline, and your budget. We’ll come back with a plan in 24 hours.',
    ar: 'أخبرنا عن منتجاتك وجدولك الزمني وميزانيتك. سنعود إليك بخطة خلال 24 ساعة.',
  },
  contactAddress: { en: 'Sanam Tower, Floor 33', ar: 'برج سنام، الدور 33' },
  contactCity: { en: 'Fahad Al-Salem Street, Kuwait City', ar: 'شارع فهد السالم، مدينة الكويت' },

  footerTagline: {
    en: 'The store builder behind Kuwait’s best independent shops.',
    ar: 'منصة بناء المتاجر خلف أفضل المتاجر المستقلة في الكويت.',
  },
  footerCopyright: {
    en: '© 2026 Force Media Kuwait. All rights reserved.',
    ar: '© 2026 فورس ميديا الكويت. جميع الحقوق محفوظة.',
  },
};

const FEATURES: Array<{ titleEn: string; titleAr: string; bodyEn: string; bodyAr: string }> = [
  {
    titleEn: 'Bilingual without compromises',
    titleAr: 'بلغتين بدون تنازلات',
    bodyEn:
      'Arabic and English are first-class throughout — schema, checkout, emails, push, invoices, SEO meta. Not a translation plugin grafted on top.',
    bodyAr:
      'العربية والإنجليزية مدعومتان بالكامل في كل تفاصيل المنصة — قاعدة البيانات والدفع والإيميلات والإشعارات والفواتير. ليست مجرد إضافة ترجمة.',
  },
  {
    titleEn: 'iOS push that actually works',
    titleAr: 'إشعارات iOS تعمل فعلاً',
    bodyEn:
      'Web push on iPhone is hard — we run two OneSignal apps, branded opt-in, and a tested install-to-home-screen flow. Customers get pinged when their order ships.',
    bodyAr:
      'إشعارات الويب على iPhone صعبة — نشغّل تطبيقين من OneSignal وحوار اشتراك مخصص وتدفق تثبيت مجرّب على الشاشة الرئيسية. العملاء يصلهم تنبيه فور شحن طلبهم.',
  },
  {
    titleEn: 'Operator-grade dashboard',
    titleAr: 'لوحة تحكم احترافية',
    bodyEn:
      'New orders push to your phone the second checkout completes. Bulk import 5k products, manage variants, fulfil orders, all from a PWA installed to your home screen.',
    bodyAr:
      'الطلبات الجديدة ترسل إلى هاتفك لحظة إتمام الدفع. استيراد 5 آلاف منتج، إدارة التنويعات، إنجاز الطلبات — من تطبيق على شاشتك الرئيسية.',
  },
  {
    titleEn: 'Multi-tenant by design',
    titleAr: 'متعدد المتاجر منذ التصميم',
    bodyEn:
      'Run several brands or pilot a new line without paying for a separate Shopify subscription each time. Tenant isolation enforced at the database level.',
    bodyAr:
      'شغّل عدة علامات تجارية أو جرّب خط منتجات جديد بدون اشتراك Shopify مستقل لكل واحد. عزل المتاجر مفروض على مستوى قاعدة البيانات.',
  },
];

const SERVICES: Array<{ titleEn: string; titleAr: string; bodyEn: string; bodyAr: string }> = [
  {
    titleEn: 'Storefront design',
    titleAr: 'تصميم المتجر',
    bodyEn:
      'Pick a template, customize colors, fonts, hero, sections — everything tenant-editable.',
    bodyAr: 'اختر قالباً، خصص الألوان والخطوط والقسم الرئيسي والأقسام — كل شيء قابل للتعديل.',
  },
  {
    titleEn: 'Product catalog',
    titleAr: 'كتالوج المنتجات',
    bodyEn: 'Categories, variants, images, SKUs, inventory tracking, bulk CSV/XLSX import.',
    bodyAr: 'فئات، تنويعات، صور، أكواد SKU، تتبع مخزون، استيراد بالجملة من CSV/XLSX.',
  },
  {
    titleEn: 'Cart & checkout',
    titleAr: 'السلة والدفع',
    bodyEn: 'Guest checkout, address book, coupons, shipping zones, tax rules, multi-currency.',
    bodyAr: 'دفع للضيوف، دفتر عناوين، كوبونات، مناطق شحن، قواعد ضريبية، دعم عملات متعددة.',
  },
  {
    titleEn: 'Order management',
    titleAr: 'إدارة الطلبات',
    bodyEn: 'Status workflow, refunds, returns, shipment tracking, automated invoices.',
    bodyAr: 'مراحل الطلب، الاسترداد، المرتجعات، تتبع الشحنات، فواتير تلقائية.',
  },
  {
    titleEn: 'Customer engagement',
    titleAr: 'تواصل مع العملاء',
    bodyEn: 'Wishlist, reviews, abandoned cart recovery, loyalty points, affiliate program.',
    bodyAr: 'قائمة الأمنيات، التقييمات، استرجاع السلات المتروكة، نقاط الولاء، برنامج المسوقين.',
  },
  {
    titleEn: 'Marketing pixels',
    titleAr: 'بكسلات التسويق',
    bodyEn: 'Meta, TikTok, Snapchat, GA4, GTM — wired in per-store, no code.',
    bodyAr: 'ميتا، تيك توك، سناب شات، جوجل أناليتكس، GTM — كلها مفعّلة لكل متجر بدون كود.',
  },
  {
    titleEn: 'SEO & speed',
    titleAr: 'SEO والسرعة',
    bodyEn:
      'Per-store meta, sitemap, structured data, and a Vercel edge-cached storefront for fast page loads.',
    bodyAr:
      'بيانات SEO لكل متجر، خريطة موقع، بيانات منظمة، وتخزين مؤقت على Vercel Edge لتحميل سريع.',
  },
  {
    titleEn: 'Custom domain',
    titleAr: 'نطاق مخصص',
    bodyEn: 'Bring your own domain (e.g. yourshop.com) with automatic SSL and DNS guidance.',
    bodyAr: 'استخدم نطاقك الخاص (مثل yourshop.com) مع شهادات SSL تلقائية ومساعدة في الإعدادات.',
  },
];

// Real integrations the platform ships with. Listed because every
// competitor lists theirs and it builds credibility — not because
// having KNet alone differentiates us.
const INTEGRATIONS: Array<{ label: string; tag: string }> = [
  { label: 'Tap', tag: 'Payments' },
  { label: 'MyFatoorah', tag: 'Payments' },
  { label: 'Hesabe', tag: 'Payments' },
  { label: 'UPayments', tag: 'Payments' },
  { label: 'KNet', tag: 'Payments' },
  { label: 'OneSignal', tag: 'Push' },
  { label: 'Cloudflare R2', tag: 'Storage' },
  { label: 'Meta Pixel', tag: 'Pixels' },
  { label: 'TikTok Pixel', tag: 'Pixels' },
  { label: 'Snap Pixel', tag: 'Pixels' },
  { label: 'GA4 / GTM', tag: 'Analytics' },
  { label: 'iCarry / Aramex', tag: 'Shipping' },
];

const AUDIENCES: Array<{ titleEn: string; titleAr: string; bodyEn: string; bodyAr: string }> = [
  {
    titleEn: 'B2C storefronts',
    titleAr: 'متاجر للمستهلكين',
    bodyEn:
      'Fashion, beauty, food, electronics, gifts. Customer accounts, wishlist, reviews, marketing pixels, push promotions.',
    bodyAr:
      'الأزياء والجمال والطعام والإلكترونيات والهدايا. حسابات العملاء، قائمة الأمنيات، التقييمات، بكسلات التسويق، عروض ترويجية بالإشعارات.',
  },
  {
    titleEn: 'B2B catalogues',
    titleAr: 'متاجر البيع بالجملة',
    bodyEn:
      'Wholesale, restocking platforms, distributor portals. Variant pricing, bulk SKUs, custom-domain login, owner and admin roles.',
    bodyAr:
      'البيع بالجملة، منصات إعادة التوريد، بوابات الموزعين. تسعير حسب التنويع، SKUs بالجملة، تسجيل دخول بنطاق مخصص، أدوار مالك ومدير.',
  },
  {
    titleEn: 'Multi-brand operators',
    titleAr: 'المشغلون متعددو العلامات',
    bodyEn:
      'Run several stores from one admin without paying per-store Shopify subscriptions. Switch context with one click.',
    bodyAr:
      'شغّل عدة متاجر من لوحة تحكم واحدة بدون اشتراكات Shopify منفصلة لكل متجر. التبديل بين المتاجر بنقرة واحدة.',
  },
];

const INCLUDED: Array<{ titleEn: string; titleAr: string; bodyEn: string; bodyAr: string }> = [
  {
    titleEn: 'Discovery + setup',
    titleAr: 'استشارة وإعداد',
    bodyEn:
      'A 30-minute call to map your products and constraints, then we provision your store and integrations — you don’t click through a wizard.',
    bodyAr:
      'مكالمة 30 دقيقة لفهم منتجاتك ومتطلباتك، ثم نُجهّز متجرك وتكاملاتك — أنت لا تتجوّل في معالج إعدادات.',
  },
  {
    titleEn: 'Catalogue load',
    titleAr: 'رفع الكتالوج',
    bodyEn:
      'Send us your products as a spreadsheet (or photos + descriptions) and we import them — variants, categories, images.',
    bodyAr: 'أرسل لنا منتجاتك بصيغة Excel (أو صور ووصف) ونحن نرفعها — تنويعات، فئات، وصور.',
  },
  {
    titleEn: 'Training + handover',
    titleAr: 'تدريب وتسليم',
    bodyEn:
      'Walk-through with your team on the admin app: orders, refunds, products, customers, marketing. Recording included.',
    bodyAr:
      'جلسة شرح لفريقك على تطبيق الإدارة: الطلبات، الاسترداد، المنتجات، العملاء، التسويق. تسجيل الجلسة مشمول.',
  },
  {
    titleEn: 'Ongoing support',
    titleAr: 'دعم مستمر',
    bodyEn:
      'A direct WhatsApp line for issues and feature requests — same number you use to start the conversation.',
    bodyAr: 'خط واتساب مباشر للمشاكل وطلبات الميزات — نفس الرقم الذي تبدأ به المحادثة.',
  },
];

const STEPS: Array<{
  n: number;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
}> = [
  {
    n: 1,
    titleEn: 'Discovery',
    titleAr: 'التعرف على متجرك',
    bodyEn: 'We learn your products, audience, and goals over a 30-min call.',
    bodyAr: 'نتعرف على منتجاتك وعملائك وأهدافك في مكالمة مدتها 30 دقيقة.',
  },
  {
    n: 2,
    titleEn: 'Setup',
    titleAr: 'الإعداد',
    bodyEn: 'We provision your store, design the look, integrate payments, and load your catalog.',
    bodyAr: 'نُجهّز متجرك، نصمم الواجهة، نربط وسائل الدفع، ونرفع كتالوج منتجاتك.',
  },
  {
    n: 3,
    titleEn: 'Launch',
    titleAr: 'الإطلاق',
    bodyEn: 'We train your team, run final QA, and go live. Ongoing support included.',
    bodyAr: 'ندرّب فريقك، نُجري الاختبار النهائي، ونطلق المتجر. الدعم المستمر مشمول.',
  },
];

const WHATSAPP_URL = 'https://wa.me/96566740311';
const PHONE = '+965 66740311';
const EMAIL = 'info@forcemediakw.com';
const FORCE_MEDIA_URL = 'https://forcemediakw.com';

interface PlatformLandingProps {
  /**
   * When set, renders a "Store not found" banner above the hero —
   * used by the 404 page to signal that the URL was wrong without
   * losing the rest of the platform pitch.
   */
  notFoundBanner?: boolean;
}

export function PlatformLanding({ notFoundBanner = false }: PlatformLandingProps) {
  const [lang, setLang] = useState<Lang>('en');

  useEffect(() => {
    const saved =
      typeof window !== 'undefined' ? window.localStorage.getItem('platform-lang') : null;
    if (saved === 'ar' || saved === 'en') setLang(saved);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('platform-lang', lang);
      document.documentElement.lang = lang;
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    }
  }, [lang]);

  const t = (e: { en: string; ar: string }) => e[lang];

  return (
    <div className="min-h-screen bg-white text-[#2C2C2C]" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-gray-100 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/" className="flex items-center gap-2">
            {/* Force F mark — the real Force Media logo, not a placeholder. */}
            <img src="/logo.svg" alt="Force" className="h-7 w-auto" />
            <span className="text-lg font-bold tracking-tight">{t(COPY.brand)}</span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm md:flex">
            <a href="#services" className="text-gray-600 transition-colors hover:text-gray-900">
              {t(COPY.navServices)}
            </a>
            <a href="#process" className="text-gray-600 transition-colors hover:text-gray-900">
              {t(COPY.navProcess)}
            </a>
            <a href="#contact" className="text-gray-600 transition-colors hover:text-gray-900">
              {t(COPY.navContact)}
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
              className="rounded-md border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:border-gray-300"
            >
              {t(COPY.langToggle)}
            </button>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden rounded-md px-4 py-1.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 sm:inline-block"
              style={{ backgroundColor: ORANGE }}
            >
              {t(COPY.navStart)}
            </a>
          </div>
        </div>
      </header>

      {notFoundBanner && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-900">
          <strong className="font-semibold">404 — </strong>
          {lang === 'ar'
            ? 'هذا المتجر غير موجود على منصتنا. تعرّف على ما نقدّمه أدناه.'
            : 'That store doesn’t exist on our platform. Here’s what we offer.'}
        </div>
      )}

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0 -z-10 opacity-[0.03]"
          style={{
            backgroundImage: `radial-gradient(${ORANGE} 1px, transparent 1px)`,
            backgroundSize: '24px 24px',
          }}
        />
        <div className="mx-auto max-w-5xl px-4 py-20 text-center md:py-28">
          <h1 className="mb-6 text-4xl font-extrabold leading-tight tracking-tight md:text-6xl">
            {t(COPY.heroTitle)}
          </h1>
          <p className="mx-auto mb-10 max-w-2xl text-lg text-gray-600 md:text-xl">
            {t(COPY.heroSubtitle)}
          </p>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg px-6 py-3 text-base font-semibold text-white shadow-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: ORANGE }}
            >
              {t(COPY.heroCta1)}
            </a>
            <a
              href={`mailto:${EMAIL}`}
              className="inline-flex items-center gap-2 rounded-lg border-2 px-6 py-3 text-base font-semibold transition-colors"
              style={{ borderColor: ORANGE, color: ORANGE }}
            >
              {t(COPY.heroCta2)}
            </a>
          </div>
        </div>
      </section>

      {/* Why */}
      <section className="bg-gray-50 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mb-12 text-center">
            <h2 className="mb-3 text-3xl font-bold md:text-4xl">{t(COPY.whySectionTitle)}</h2>
            <div className="mx-auto h-1 w-16 rounded" style={{ backgroundColor: ORANGE }} />
            <p className="mx-auto mt-4 max-w-2xl text-gray-600">{t(COPY.whySectionSubtitle)}</p>
          </div>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f, i) => (
              <div key={i} className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
                <div
                  className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white"
                  style={{ backgroundColor: ORANGE }}
                >
                  {i + 1}
                </div>
                <h3 className="mb-2 text-lg font-bold">{lang === 'ar' ? f.titleAr : f.titleEn}</h3>
                <p className="text-sm text-gray-600">{lang === 'ar' ? f.bodyAr : f.bodyEn}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Services */}
      <section id="services" className="py-20">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mb-12 text-center">
            <h2 className="mb-3 text-3xl font-bold md:text-4xl">{t(COPY.servicesTitle)}</h2>
            <div className="mx-auto h-1 w-16 rounded" style={{ backgroundColor: ORANGE }} />
            <p className="mx-auto mt-4 max-w-2xl text-gray-600">{t(COPY.servicesSubtitle)}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {SERVICES.map((s, i) => (
              <div
                key={i}
                className="rounded-xl border border-gray-100 bg-white p-5 transition-shadow hover:shadow-md"
              >
                <h3 className="mb-2 text-base font-bold" style={{ color: ORANGE }}>
                  {lang === 'ar' ? s.titleAr : s.titleEn}
                </h3>
                <p className="text-sm text-gray-600">{lang === 'ar' ? s.bodyAr : s.bodyEn}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Process */}
      <section id="process" className="bg-gray-50 py-20">
        <div className="mx-auto max-w-5xl px-4">
          <div className="mb-12 text-center">
            <h2 className="mb-3 text-3xl font-bold md:text-4xl">{t(COPY.processTitle)}</h2>
            <div className="mx-auto h-1 w-16 rounded" style={{ backgroundColor: ORANGE }} />
            <p className="mx-auto mt-4 max-w-2xl text-gray-600">{t(COPY.processSubtitle)}</p>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <div key={i} className="relative rounded-xl bg-white p-6 shadow-sm">
                <div
                  className="mb-4 flex h-12 w-12 items-center justify-center rounded-full text-lg font-extrabold text-white"
                  style={{ backgroundColor: ORANGE }}
                >
                  {s.n}
                </div>
                <h3 className="mb-2 text-xl font-bold">{lang === 'ar' ? s.titleAr : s.titleEn}</h3>
                <p className="text-sm text-gray-600">{lang === 'ar' ? s.bodyAr : s.bodyEn}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Audience */}
      <section className="py-20">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mb-12 text-center">
            <h2 className="mb-3 text-3xl font-bold md:text-4xl">{t(COPY.audienceTitle)}</h2>
            <div className="mx-auto h-1 w-16 rounded" style={{ backgroundColor: ORANGE }} />
            <p className="mx-auto mt-4 max-w-2xl text-gray-600">{t(COPY.audienceSubtitle)}</p>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {AUDIENCES.map((a, i) => (
              <div
                key={i}
                className="rounded-xl border border-gray-100 bg-white p-6 transition-shadow hover:shadow-md"
              >
                <h3 className="mb-2 text-lg font-bold">{lang === 'ar' ? a.titleAr : a.titleEn}</h3>
                <p className="text-sm text-gray-600">{lang === 'ar' ? a.bodyAr : a.bodyEn}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Integrations */}
      <section className="bg-gray-50 py-16">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mb-8 text-center">
            <h2 className="mb-3 text-2xl font-bold md:text-3xl">{t(COPY.integrationsTitle)}</h2>
            <p className="mx-auto max-w-2xl text-sm text-gray-600">
              {t(COPY.integrationsSubtitle)}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {INTEGRATIONS.map((it, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700"
              >
                <span>{it.label}</span>
                <span className="text-xs uppercase tracking-wide text-gray-400">· {it.tag}</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* What's included (onboarding promise) */}
      <section className="py-20">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mb-12 text-center">
            <h2 className="mb-3 text-3xl font-bold md:text-4xl">{t(COPY.includedTitle)}</h2>
            <div className="mx-auto h-1 w-16 rounded" style={{ backgroundColor: ORANGE }} />
            <p className="mx-auto mt-4 max-w-2xl text-gray-600">{t(COPY.includedSubtitle)}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {INCLUDED.map((s, i) => (
              <div key={i} className="rounded-xl border border-gray-100 bg-white p-5">
                <h3 className="mb-2 text-base font-bold" style={{ color: ORANGE }}>
                  {lang === 'ar' ? s.titleAr : s.titleEn}
                </h3>
                <p className="text-sm text-gray-600">{lang === 'ar' ? s.bodyAr : s.bodyEn}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Marketing callout */}
      <section className="py-20">
        <div className="mx-auto max-w-4xl px-4">
          <div
            className="overflow-hidden rounded-2xl p-8 text-white shadow-xl md:p-12"
            style={{
              background: `linear-gradient(135deg, ${ORANGE_DARK}, ${ORANGE})`,
            }}
          >
            <h2 className="mb-3 text-2xl font-bold md:text-3xl">{t(COPY.marketingCalloutTitle)}</h2>
            <p className="mb-6 text-base opacity-95 md:text-lg">{t(COPY.marketingCalloutBody)}</p>
            <a
              href={FORCE_MEDIA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3 text-sm font-semibold transition-opacity hover:opacity-90"
              style={{ color: ORANGE }}
            >
              {t(COPY.marketingCalloutCta)}
            </a>
          </div>
        </div>
      </section>

      {/* Sister-product callout — Force Bulk WhatsApp */}
      <section className="pb-20">
        <div className="mx-auto max-w-4xl px-4">
          <div className="rounded-2xl border-2 p-8 md:p-10" style={{ borderColor: ORANGE }}>
            <div
              className="mb-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide"
              style={{ color: ORANGE }}
            >
              <span>📲</span>
              <span>{lang === 'ar' ? 'منتج شقيق' : 'Sister product'}</span>
            </div>
            <h2 className="mb-3 text-2xl font-bold md:text-3xl">{t(COPY.wbsCalloutTitle)}</h2>
            <p className="mb-6 text-base text-gray-600 md:text-lg">{t(COPY.wbsCalloutBody)}</p>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: ORANGE }}
            >
              {t(COPY.wbsCalloutCta)}
            </a>
          </div>
        </div>
      </section>

      {/* Contact */}
      <section id="contact" className="bg-gray-50 py-20">
        <div className="mx-auto max-w-4xl px-4">
          <div className="mb-12 text-center">
            <h2 className="mb-3 text-3xl font-bold md:text-4xl">{t(COPY.contactTitle)}</h2>
            <div className="mx-auto h-1 w-16 rounded" style={{ backgroundColor: ORANGE }} />
            <p className="mx-auto mt-4 max-w-xl text-gray-600">{t(COPY.contactSubtitle)}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center gap-2 rounded-xl border border-gray-100 bg-white p-6 text-center transition-shadow hover:shadow-md"
            >
              <span className="text-2xl">💬</span>
              <span className="text-xs uppercase tracking-wide text-gray-500">WhatsApp</span>
              <span className="font-semibold" style={{ color: ORANGE }} dir="ltr">
                {PHONE}
              </span>
            </a>
            <a
              href={`mailto:${EMAIL}`}
              className="flex flex-col items-center gap-2 rounded-xl border border-gray-100 bg-white p-6 text-center transition-shadow hover:shadow-md"
            >
              <span className="text-2xl">✉</span>
              <span className="text-xs uppercase tracking-wide text-gray-500">Email</span>
              <span className="font-semibold" style={{ color: ORANGE }} dir="ltr">
                {EMAIL}
              </span>
            </a>
            <div className="flex flex-col items-center gap-2 rounded-xl border border-gray-100 bg-white p-6 text-center">
              <span className="text-2xl">📍</span>
              <span className="text-xs uppercase tracking-wide text-gray-500">
                {lang === 'ar' ? 'العنوان' : 'Office'}
              </span>
              <span className="text-sm font-medium">{t(COPY.contactAddress)}</span>
              <span className="text-xs text-gray-500">{t(COPY.contactCity)}</span>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 bg-white py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-sm text-gray-500 md:flex-row">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="Force" className="h-6 w-auto" />
            <span className="font-semibold text-gray-700">{t(COPY.brand)}</span>
            <span className="hidden md:inline">— {t(COPY.footerTagline)}</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href={FORCE_MEDIA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-gray-700"
            >
              forcemediakw.com
            </a>
            <span className="text-xs">{t(COPY.footerCopyright)}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
