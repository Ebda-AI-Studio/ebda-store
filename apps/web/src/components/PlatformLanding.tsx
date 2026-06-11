'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';

/**
 * Platform landing page for `store.forcemediakw.com` — replaces the
 * old "redirect to forcemediakw.com" behaviour with a properly
 * positioned page about the Force AI Store Builder service itself.
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
  // Force AI = company, Force AI Store = product on this page.
  // Header shows the product name prominently with the company as a
  // smaller affiliation line — same pattern Stripe uses (Stripe /
  // Atlas, Stripe / Climate). Visitors see what page they're on
  // first, then who makes it.
  brand: { en: 'Force AI Store', ar: 'فورس ستور' },
  brandCompany: { en: 'by Force AI', ar: 'من Force AI' },
  langToggle: { en: 'عربي', ar: 'English' },
  navServices: { en: 'What we do', ar: 'خدماتنا' },
  navProcess: { en: 'How it works', ar: 'خطواتنا' },
  navContact: { en: 'Contact', ar: 'تواصل معنا' },
  navStart: { en: 'Get started', ar: 'ابدأ الآن' },

  heroEyebrow: {
    en: 'For Kuwait merchants',
    ar: 'للتجار في الكويت',
  },
  heroTitle: {
    en: 'Sell more in Kuwait, with less hassle',
    ar: 'بيع أكثر في الكويت، بمجهود أقل',
  },
  heroSubtitle: {
    en: 'Force AI Store is a done-for-you online store that handles the boring parts — payments, delivery, taxes, customer accounts — so you can focus on products, marketing, and growing your sales.',
    ar: 'Force AI Store متجر إلكتروني نُجهّزه لك يتولى المهام الرتيبة — الدفع، التوصيل، الضرائب، حسابات العملاء — حتى تتفرغ لمنتجاتك وتسويقك ونمو مبيعاتك.',
  },
  heroCta1: { en: 'Talk on WhatsApp', ar: 'تواصل عبر واتساب' },
  heroCta2: { en: 'Email us', ar: 'راسلنا بالبريد' },

  whySectionTitle: {
    en: 'What changes when you sell here',
    ar: 'ما الذي يتغيّر عندما تبيع معنا',
  },
  whySectionSubtitle: {
    en: 'Concrete outcomes for the way Kuwaiti shoppers buy and Kuwaiti merchants operate.',
    ar: 'نتائج ملموسة تناسب طريقة شراء العملاء في الكويت وطريقة عمل التجار المحليين.',
  },

  servicesTitle: { en: 'Everything your store needs', ar: 'كل ما يحتاجه متجرك' },
  servicesSubtitle: {
    en: 'You focus on products and customers. We handle the rest.',
    ar: 'أنت تركز على منتجاتك وعملائك. نحن نتولى الباقي.',
  },

  processTitle: { en: 'From idea to live store, in days', ar: 'من الفكرة لمتجر يبيع، خلال أيام' },
  processSubtitle: {
    en: 'No long onboarding. No monthly waiting. You talk to us, we build, you sell.',
    ar: 'لا انتظار طويل للإعداد. تتحدث معنا، نبني، أنت تبيع.',
  },

  integrationsTitle: { en: 'Works with what you already use', ar: 'يعمل مع الأدوات التي تستخدمها' },
  integrationsSubtitle: {
    en: 'The payment, shipping, and marketing services Kuwaiti merchants run on — already connected.',
    ar: 'خدمات الدفع والشحن والتسويق التي يعتمد عليها التجار في الكويت — كلها متصلة بالفعل.',
  },

  audienceTitle: { en: 'Who sells with us', ar: 'من يبيع معنا' },
  audienceSubtitle: {
    en: 'Whether you sell to shoppers or to other businesses — we’ve got you covered.',
    ar: 'سواء كنت تبيع للمستهلكين أو للشركات الأخرى — نحن نغطّيك.',
  },

  includedTitle: {
    en: 'You get a working store, not a checklist',
    ar: 'تحصل على متجر يعمل، لا قائمة مهام',
  },
  includedSubtitle: {
    en: 'Most platforms hand you a self-serve dashboard and disappear. We set everything up with you.',
    ar: 'معظم المنصات تعطيك لوحة تحكم وتختفي. نحن نُجهّز كل شيء معك.',
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
    en: 'Force AI WhatsApp Business Platform is our sister product. Send personalised WhatsApp campaigns to hundreds or thousands of customers at once — promotions, order updates, abandoned-cart reminders. Bundle it with your store and we’ll connect your customer list on day one.',
    ar: 'منصة فورس لأعمال واتساب هي منتجنا الشقيق. أرسل حملات واتساب مخصصة لمئات أو آلاف العملاء دفعة واحدة — عروض، تحديثات طلبات، تذكير بالسلات المتروكة. اشترك معه مع متجرك ونربط قائمة عملائك من اليوم الأول.',
  },
  wbsCalloutCta: { en: 'Ask about the bundle', ar: 'اسأل عن الباقة المشتركة' },

  contactTitle: { en: 'Get in touch', ar: 'تواصل معنا' },
  contactSubtitle: {
    en: 'Tell us what you sell. We come back in 24 hours with a clear plan and a price.',
    ar: 'أخبرنا ماذا تبيع. سنعود إليك خلال 24 ساعة بخطة واضحة وسعر محدد.',
  },
  contactAddress: { en: 'Sanam Tower, Floor 33', ar: 'برج سنام، الدور 33' },
  contactCity: { en: 'Fahad Al-Salem Street, Kuwait City', ar: 'شارع فهد السالم، مدينة الكويت' },

  footerTagline: {
    en: 'Force AI Store + Force AI WhatsApp Business Platform · made by Force AI in Kuwait.',
    ar: 'Force AI Store و Force AI WhatsApp Business Platform · من إنتاج Force AI في الكويت.',
  },
  footerCopyright: {
    en: '© 2026 Force Media Kuwait. All rights reserved.',
    ar: '© 2026 فورس ميديا الكويت. جميع الحقوق محفوظة.',
  },
};

const FEATURES: Array<{ titleEn: string; titleAr: string; bodyEn: string; bodyAr: string }> = [
  {
    titleEn: 'Reach Arabic and English customers equally',
    titleAr: 'اوصل لعملاء العربية والإنجليزية بنفس الجودة',
    bodyEn:
      'Your store, checkout, receipts, and notifications all speak both languages naturally. No customer drops off because the page reads wrong.',
    bodyAr:
      'متجرك وصفحة الدفع والإيصالات والإشعارات بلغتين بشكل طبيعي. لا تخسر عميلاً لأن الصفحة تقرأ بشكل خاطئ.',
  },
  {
    titleEn: 'Bring customers back without paying for ads',
    titleAr: 'أعد عملاءك بدون مصاريف إعلانات',
    bodyEn:
      'Send promotions and order updates straight to their phones — even on iPhone. Repeat sales without spending on Meta or TikTok every time.',
    bodyAr:
      'أرسل العروض وتحديثات الطلبات مباشرة إلى هواتفهم — حتى على iPhone. مبيعات متكررة بدون صرف على ميتا أو تيك توك في كل مرة.',
  },
  {
    titleEn: 'Manage everything from your phone',
    titleAr: 'أدر كل شيء من هاتفك',
    bodyEn:
      'A new order? Your phone buzzes. Update a price, change stock, refund a customer, all from your home-screen app — wherever you are.',
    bodyAr:
      'طلب جديد؟ هاتفك يرنّ. عدّل سعراً، غيّر مخزوناً، استرد لعميل — كل ذلك من تطبيق على شاشتك الرئيسية، أينما كنت.',
  },
  {
    titleEn: 'Run several brands from one place',
    titleAr: 'شغّل عدة علامات تجارية من مكان واحد',
    bodyEn:
      'Selling more than one brand or product line? Open a second store without paying double. Switch between them with one tap.',
    bodyAr:
      'تبيع أكثر من علامة تجارية أو خط منتجات؟ افتح متجراً ثانياً بدون دفع ضعف الاشتراك. التبديل بنقرة واحدة.',
  },
];

const SERVICES: Array<{ titleEn: string; titleAr: string; bodyEn: string; bodyAr: string }> = [
  {
    titleEn: 'A store that looks the part',
    titleAr: 'متجر بمظهر احترافي',
    bodyEn:
      'Clean, modern designs your customers trust. Pick the template, tweak colours and copy until it feels like your brand.',
    bodyAr:
      'تصاميم نظيفة وعصرية تكسب ثقة عملاءك. اختر القالب، عدّل الألوان والنصوص حتى يعكس علامتك.',
  },
  {
    titleEn: 'Products done right',
    titleAr: 'إدارة منتجات صحيحة',
    bodyEn:
      'Sizes, colours, live stock, photos, prices in Arabic and English. Upload thousands at once from Excel.',
    bodyAr:
      'مقاسات، ألوان، مخزون لحظي، صور، أسعار بالعربية والإنجليزية. ارفع آلاف المنتجات دفعة واحدة من Excel.',
  },
  {
    titleEn: 'Checkout that converts',
    titleAr: 'صفحة دفع تحوّل الزوار لمشترين',
    bodyEn:
      'Guest checkout, saved addresses, coupons, shipping zones, taxes — fewer abandoned carts, more completed orders.',
    bodyAr:
      'دفع للضيوف، عناوين محفوظة، كوبونات، مناطق شحن، ضرائب — سلات مهجورة أقل، وطلبات مكتملة أكثر.',
  },
  {
    titleEn: 'Orders without chaos',
    titleAr: 'طلبات بدون فوضى',
    bodyEn:
      'Track every order from new to delivered. Refund a customer in two taps. Send shipment tracking automatically.',
    bodyAr: 'تابع كل طلب من جديد إلى تم التسليم. استرد لعميل بنقرتين. أرسل تتبع الشحنة تلقائياً.',
  },
  {
    titleEn: 'Bring buyers back',
    titleAr: 'أعد المشترين مرة أخرى',
    bodyEn:
      'Wishlist, reviews, cart-recovery emails, loyalty points, affiliate program — built-in ways to grow repeat sales.',
    bodyAr:
      'قائمة أمنيات، تقييمات، إيميلات لاسترجاع السلة، نقاط ولاء، برنامج مسوقين — أدوات لتكرار البيع.',
  },
  {
    titleEn: 'Track what your ads do',
    titleAr: 'اعرف ما الذي تفعله إعلاناتك',
    bodyEn:
      'Meta, TikTok, Snap, and Google all see the right events from your store, so your ROAS reports are honest.',
    bodyAr:
      'ميتا، تيك توك، سناب، وجوجل ترى الأحداث الصحيحة من متجرك، فتقارير عائد الإعلان تكون دقيقة.',
  },
  {
    titleEn: 'Found on Google',
    titleAr: 'مرئي على جوجل',
    bodyEn:
      'Each product page is built to rank — meta tags, sitemap, structured data, and fast loading. Free traffic over time.',
    bodyAr:
      'كل صفحة منتج مهيأة للظهور في نتائج البحث — معلومات الصفحة، خريطة الموقع، بيانات منظمة، تحميل سريع. زيارات مجانية مع الوقت.',
  },
  {
    titleEn: 'Your own domain',
    titleAr: 'نطاق متجرك الخاص',
    bodyEn:
      'Run on yourshop.com (or a name you own). We set up DNS and SSL for you — customers see your brand, not ours.',
    bodyAr:
      'شغّل المتجر على yourshop.com (أو نطاقك الخاص). نُجهّز DNS و SSL لك — عملاءك يرون علامتك، لا علامتنا.',
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
    titleEn: 'Selling to shoppers',
    titleAr: 'تبيع للمستهلكين',
    bodyEn:
      'Fashion, beauty, food, electronics, gifts — anywhere customers buy with their phones. We give them a fast, friendly store and you the tools to bring them back.',
    bodyAr:
      'أزياء، جمال، طعام، إلكترونيات، هدايا — في أي مجال يشتري فيه العملاء عبر هواتفهم. نُقدّم لهم متجراً سريعاً وودوداً، ونعطيك أدوات تُعيدهم للشراء مرة أخرى.',
  },
  {
    titleEn: 'Selling to businesses',
    titleAr: 'تبيع للشركات',
    bodyEn:
      'Wholesale, distributors, restocking. Set different prices per customer, hide the catalogue behind a login, take big orders without phone calls.',
    bodyAr:
      'بيع بالجملة، موزعين، إعادة توريد. ضع أسعاراً مختلفة لكل عميل، أخفِ الكتالوج خلف تسجيل دخول، استقبل طلبات كبيرة بدون مكالمات هاتفية.',
  },
  {
    titleEn: 'Running more than one brand',
    titleAr: 'تدير أكثر من علامة تجارية',
    bodyEn:
      'Two stores, three lines, a pilot brand — open them all from one place without paying for each one separately.',
    bodyAr:
      'متجران، ثلاثة خطوط، علامة تجريبية — افتحها كلها من مكان واحد بدون اشتراك مستقل لكل واحدة.',
  },
];

const INCLUDED: Array<{ titleEn: string; titleAr: string; bodyEn: string; bodyAr: string }> = [
  {
    titleEn: 'A 30-minute call',
    titleAr: 'مكالمة 30 دقيقة',
    bodyEn:
      'You tell us about your products, your customers, and your timeline. We come back with a clear plan — no jargon, no upsells.',
    bodyAr:
      'تخبرنا عن منتجاتك وعملائك وجدولك الزمني. نعود إليك بخطة واضحة — بدون مصطلحات معقدة وبدون عروض إضافية.',
  },
  {
    titleEn: 'Your products, uploaded for you',
    titleAr: 'منتجاتك، نرفعها نحن',
    bodyEn:
      'Send us an Excel sheet — or just photos and prices. We do the upload, the variants, the categories. You review.',
    bodyAr:
      'أرسل لنا ملف Excel — أو فقط صوراً وأسعاراً. نحن نتولّى الرفع والتنويعات والفئات. أنت تراجع.',
  },
  {
    titleEn: 'Training your team',
    titleAr: 'تدريب فريقك',
    bodyEn:
      'A walkthrough with you and your staff on receiving orders, refunds, updating products, and reading reports. Video kept for new hires.',
    bodyAr:
      'جلسة شرح معك ومع فريقك على استقبال الطلبات والاسترداد وتحديث المنتجات وقراءة التقارير. الفيديو محفوظ للموظفين الجدد.',
  },
  {
    titleEn: 'A WhatsApp number that answers',
    titleAr: 'رقم واتساب يردّ عليك',
    bodyEn:
      'After launch you keep the same WhatsApp line. Real humans, real responses — not a ticket queue.',
    bodyAr:
      'بعد الإطلاق تبقى على نفس خط الواتساب. أشخاص حقيقيون وردود سريعة — ليست بطاقات دعم في طابور.',
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
    titleEn: 'We talk',
    titleAr: 'نتحدث',
    bodyEn:
      'You tell us what you sell, who buys it, and where you want to be in three months. No demo, just a conversation.',
    bodyAr:
      'تخبرنا ماذا تبيع، من يشتري منك، وأين تريد أن تكون بعد ثلاثة أشهر. لا عرض تقديمي، فقط محادثة.',
  },
  {
    n: 2,
    titleEn: 'We build',
    titleAr: 'نبني',
    bodyEn:
      'Your store goes live with your products, your colours, your domain. Payments tested, delivery wired, ready to take orders.',
    bodyAr:
      'متجرك يصبح جاهزاً بمنتجاتك، ألوانك، نطاقك. الدفع مُجرّب، التوصيل موصول، وجاهز لاستقبال الطلبات.',
  },
  {
    n: 3,
    titleEn: 'You sell',
    titleAr: 'أنت تبيع',
    bodyEn:
      'You announce, we monitor, customers buy. We stay close for the first weeks to fix anything that comes up.',
    bodyAr:
      'أنت تعلن، نحن نراقب، العملاء يشترون. نبقى قريبين منك في الأسابيع الأولى لمعالجة أي شيء يطرأ.',
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
          <Link href="/" className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="Force AI Store" className="h-9 w-auto md:h-10" />
            <div className="flex flex-col leading-none">
              <span className="text-xl font-extrabold tracking-tight text-gray-900 md:text-2xl">
                {t(COPY.brand)}
              </span>
              <span
                className="mt-0.5 text-xs font-bold uppercase tracking-[0.18em] md:text-[13px]"
                style={{ color: ORANGE }}
              >
                {t(COPY.brandCompany)}
              </span>
            </div>
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
          <p
            className="mb-4 inline-block rounded-full border px-4 py-1.5 text-xs font-semibold uppercase tracking-wide"
            style={{ borderColor: ORANGE, color: ORANGE }}
          >
            {t(COPY.heroEyebrow)}
          </p>
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

      {/* Sister-product callout — Force AI WhatsApp Business Platform.
          Sits BEFORE the parent-brand marketing callout so the
          adjacent product upsell (operational use case for an
          existing Force AI Store customer) is the first cross-sell a
          merchant sees. The marketing callout below cross-sells the
          parent brand for traffic acquisition. */}
      <section className="py-20">
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

      {/* Marketing callout — parent brand cross-sell */}
      <section className="pb-20">
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
            <a
              href="https://www.google.com/maps/search/?api=1&query=Sanam+Tower+Kuwait+City"
              target="_blank"
              rel="noopener noreferrer"
              aria-label={
                lang === 'ar' ? 'افتح برج سنام في خرائط جوجل' : 'Open Sanam Tower in Google Maps'
              }
              className="flex flex-col items-center gap-2 rounded-xl border border-gray-100 bg-white p-6 text-center transition-shadow hover:shadow-md"
            >
              <span className="text-2xl">📍</span>
              <span className="text-xs uppercase tracking-wide text-gray-500">
                {lang === 'ar' ? 'العنوان' : 'Office'}
              </span>
              <span className="text-sm font-medium">{t(COPY.contactAddress)}</span>
              <span className="text-xs text-gray-500">{t(COPY.contactCity)}</span>
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 bg-white py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-sm text-gray-500 md:flex-row">
          <div className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="Force AI Store" className="h-7 w-auto" />
            <div className="flex flex-col leading-none">
              <span className="text-base font-extrabold text-gray-800">{t(COPY.brand)}</span>
              <span
                className="mt-0.5 text-[11px] font-bold uppercase tracking-[0.18em]"
                style={{ color: ORANGE }}
              >
                {t(COPY.brandCompany)}
              </span>
            </div>
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
