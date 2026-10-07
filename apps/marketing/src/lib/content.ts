import { LEGAL_AR } from './legal-ar';
import { LEGAL_EN } from './legal-en';
import type { LegalPages } from './legal-types';
import type { Locale } from './site';

export interface Copy {
  meta: { title: string; description: string };
  skip: string;
  nav: {
    label: string;
    features: string;
    solutions: string;
    pricing: string;
    resources: string;
    login: string;
    start: string;
    menu: string;
    switchTo: string;
    switchLabel: string;
  };
  hero: { h1: string; sub: string; cta: string; secondary: string; slugLabel: string };
  /** The pinned scroll story: a store assembling inside a phone. */
  story: {
    title: string;
    steps: [string, string, string, string];
    orderTitle: string;
    orderBody: string;
    phoneLabel: string;
  };
  templates: {
    title: string;
    lead: string;
    groupLabel: string;
    devicesLabel: string;
  };
  features: { title: string; items: { t: string; d: string }[] };
  providers: {
    title: string;
    payLabel: string;
    pay: string[];
    shipLabel: string;
    ship: string[];
    ask: string;
    askLink: string;
  };
  pricing: {
    title: string;
    lead: string;
    note: string;
    perMonth: string;
    annual: string;
    trial: string;
    planCta: string;
    planCtaAnnual: string;
  };
  faq: { title: string; items: { q: string; a: string }[] };
  start: {
    title: string;
    lead: string;
    firstMerchantLabel: string;
    cta: string;
    login: string;
  };
  footer: {
    product: string;
    legalNav: string;
    legal: string;
    privacy: string;
    terms: string;
    merchant: string;
    acceptableUse: string;
    contact: string;
    /** Text before the linked company name, e.g. "A product of" → "A product of Whisky 11". */
    byPrefix: string;
    draftNote: string;
  };
  legalPages: LegalPages;
}

export const COPY: Record<Locale, Copy> = {
  ar: {
    meta: {
      title: 'ابدأ | اعمل متجرك أونلاين في دقايق',
      description:
        'اعمل متجرك أونلاين في دقايق: لينك باسمك، 5 قوالب، دفع أونلاين وكاش وإنستا باي، وشحن مع بوسطة وأرامكس. ومن غير عمولة على طلباتك.',
    },
    skip: 'روح للمحتوى',
    nav: {
      label: 'التنقل الرئيسي',
      features: 'المميزات',
      solutions: 'إزاي بيشتغل',
      pricing: 'الأسعار',
      resources: 'أسئلة',
      login: 'دخول',
      start: 'ابدأ دلوقتي',
      menu: 'القائمة',
      switchTo: 'English',
      switchLabel: 'Switch to English',
    },
    hero: {
      h1: 'ابدأ متجرك أونلاين في دقايق.',
      sub: 'لينك باسمك، منتجاتك، وطلباتك. كله من موبايلك.',
      cta: 'ابدأ دلوقتي',
      secondary: 'شوف إزاي',
      slugLabel: 'لينك متجرك',
    },
    story: {
      title: 'متجرك بيتبني قدامك.',
      steps: ['اختار اسم ولوجو.', 'نزّل منتجاتك.', 'غيّر الشكل بضغطة.', 'وأول طلب يوصلك.'],
      orderTitle: 'طلب جديد',
      orderBody: '2 كيلو كحك وغُريبة · 760 ج.م',
      phoneLabel: 'متجر أكل بيتي بيتبني على الموبايل، وبعدين بيوصله طلب جديد.',
    },
    templates: {
      title: 'خمس قوالب. اختار اللي على ذوقك.',
      lead: 'نفس المتجر على الموبايل والتابلت واللابتوب.',
      groupLabel: 'اختار قالب',
      devicesLabel: 'المتجر بالقالب المختار على لابتوب وتابلت وموبايل',
    },
    features: {
      title: 'كل اللي محتاجه عشان تبيع.',
      items: [
        { t: 'محرر صفحات', d: 'عدّل أي جزء في متجرك وشوفه قدامك على طول.' },
        { t: 'ذكاء اصطناعي معاك', d: 'يكتب وصف منتجاتك ويترجمه عربي وإنجليزي.' },
        { t: 'متجرك في جيبك', d: 'لوحة التحكم على موبايلك، وإشعار مع كل طلب.' },
        { t: 'أرقامك قدامك', d: 'اعرف إيه اللي بيتباع وإيه اللي واقف.' },
        { t: 'الضريبة محسوبة', d: 'لو مسجّل ضريبيًا، القيمة المضافة بتتحسب لوحدها.' },
        { t: 'الطلب على واتساب', d: 'العميل يبعتلك تفاصيل الطلب جاهزة بضغطة.' },
      ],
    },
    providers: {
      title: 'الدفع والشحن، زي ما عملاءك متعودين.',
      payLabel: 'الدفع',
      pay: ['الدفع عند الاستلام', 'إنستا باي', 'Paymob', 'Kashier', 'FawryPay'],
      shipLabel: 'الشحن',
      ship: ['Bosta', 'ShipBlu', 'Mylerz', 'Aramex', 'توصيل بنفسك'],
      ask: 'محتاج شركة تانية؟',
      askLink: 'قولّنا',
    },
    pricing: {
      title: 'باقة على قد متجرك.',
      lead: 'جرّب باقة النمو 14 يوم ببلاش، ومن غير عمولة على طلباتك.',
      note: 'وفّر 25% لو دفعت سنوي. رسوم بوابات الدفع منفصلة.',
      perMonth: 'في الشهر',
      annual: 'سنوي',
      trial: '14 يوم ببلاش',
      planCta: 'ابدأ بباقة {plan}',
      planCtaAnnual: 'أو ادفع سنوي ووفّر 25%',
    },
    faq: {
      title: 'أسئلة بتتسأل كتير',
      items: [
        {
          q: 'محتاج دومين؟',
          a: 'لأ. متجرك بيبقى على <اسمك>.ebda.app، ولو عندك دومين تقدر تربطه.',
        },
        {
          q: 'محتاج أعرف برمجة؟',
          a: 'خالص. لو بتعرف تنزّل بوست، هتعرف تعمل متجرك.',
        },
        {
          q: 'عملائي يقدروا يدفعوا أونلاين؟',
          a: 'أيوه، بالكارت والمحفظة عن طريق Paymob وKashier وFawryPay، وكمان كاش وإنستا باي.',
        },
        {
          q: 'المتجر بالعربي؟',
          a: 'أيوه، عربي من الأساس، ومعاه نسخة إنجليزي.',
        },
        {
          q: 'بياناتي بتاعة مين؟',
          a: 'بتاعتك. منتجاتك وطلباتك وعملاءك ملكك إنت.',
        },
      ],
    },
    start: {
      title: 'الدور عليك.',
      lead: 'اعمل متجرك النهاردة، وابدأ تبيع بكرة.',
      firstMerchantLabel: 'أول تاجر على ابدأ',
      cta: 'ابدأ دلوقتي',
      login: 'عندك متجر؟ ادخل',
    },
    footer: {
      product: 'ابدأ — منتج من Whisky 11',
      legalNav: 'روابط قانونية',
      legal: 'الإشعار القانوني',
      privacy: 'الخصوصية',
      terms: 'الشروط',
      merchant: 'اتفاقية التاجر',
      acceptableUse: 'الاستخدام المقبول',
      contact: 'تواصل: hello@ebda.app',
      byPrefix: 'منتج من',
      draftNote: 'الإصدار 1.0 من الوثائق القانونية · 2026-10-07.',
    },
    legalPages: LEGAL_AR,
  },
  en: {
    meta: {
      title: 'Ebda | Open your online store in minutes',
      description:
        'Open your online store in minutes: your own link, 5 templates, online payments, cash and InstaPay, shipping with Bosta and Aramex. No commission.',
    },
    skip: 'Skip to content',
    nav: {
      label: 'Main navigation',
      features: 'Features',
      solutions: 'How it works',
      pricing: 'Pricing',
      resources: 'FAQ',
      login: 'Log in',
      start: 'Start now',
      menu: 'Menu',
      switchTo: 'العربية',
      switchLabel: 'التبديل إلى العربية',
    },
    hero: {
      h1: 'Open your online store in minutes.',
      sub: 'Your own link, products and orders. All from your phone.',
      cta: 'Start now',
      secondary: 'See how',
      slugLabel: 'Your store link',
    },
    story: {
      title: 'Watch your store come together.',
      steps: [
        'Pick a name and logo.',
        'Add your products.',
        'Restyle it in one tap.',
        'And the first order arrives.',
      ],
      orderTitle: 'New order',
      orderBody: '2 kg kahk and ghorayeba · EGP 760',
      phoneLabel: 'A home-food store being built on a phone, then receiving a new order.',
    },
    templates: {
      title: 'Five templates. Pick your style.',
      lead: 'The same store on phone, tablet and laptop.',
      groupLabel: 'Choose a template',
      devicesLabel: 'The store in the chosen template on a laptop, tablet and phone',
    },
    features: {
      title: 'Everything you need to sell.',
      items: [
        { t: 'Page builder', d: 'Edit any part of your store and see it live.' },
        { t: 'AI on your side', d: 'Writes your product descriptions, in Arabic and English.' },
        { t: 'Your store in your pocket', d: 'The dashboard on your phone, with a ping for every order.' },
        { t: 'Your numbers', d: 'See what sells and what doesn’t.' },
        { t: 'VAT, handled', d: 'Registered for VAT? It’s calculated for you.' },
        { t: 'Orders on WhatsApp', d: 'Customers send you the order details in one tap.' },
      ],
    },
    providers: {
      title: 'Payment and shipping, the way your customers expect.',
      payLabel: 'Payment',
      pay: ['Cash on delivery', 'InstaPay', 'Paymob', 'Kashier', 'FawryPay'],
      shipLabel: 'Shipping',
      ship: ['Bosta', 'ShipBlu', 'Mylerz', 'Aramex', 'Your own delivery'],
      ask: 'Need another provider?',
      askLink: 'Tell us',
    },
    pricing: {
      title: 'A plan that fits your store.',
      lead: 'Try Growth free for 14 days. No commission on your orders.',
      note: 'Save 25% when you pay yearly. Payment gateway fees are separate.',
      perMonth: 'a month',
      annual: 'yearly',
      trial: '14 days free',
      planCta: 'Start with {plan}',
      planCtaAnnual: 'Or pay yearly and save 25%',
    },
    faq: {
      title: 'Common questions',
      items: [
        {
          q: 'Do I need a domain?',
          a: 'No. Your store lives at <you>.ebda.app, and you can connect your own domain.',
        },
        {
          q: 'Do I need to code?',
          a: 'Not at all. If you can post on Instagram, you can build your store.',
        },
        {
          q: 'Can customers pay online?',
          a: 'Yes, by card and wallet through Paymob, Kashier and FawryPay, plus cash and InstaPay.',
        },
        {
          q: 'Is the store in Arabic?',
          a: 'Yes, Arabic first, with an English version.',
        },
        {
          q: 'Who owns my data?',
          a: 'You do. Your products, orders and customers are yours.',
        },
      ],
    },
    start: {
      title: 'Your turn.',
      lead: 'Set up your store today. Start selling tomorrow.',
      firstMerchantLabel: 'First merchant on Ebda',
      cta: 'Start now',
      login: 'Have a store? Log in',
    },
    footer: {
      product: 'Ebda — a Whisky 11 product',
      legalNav: 'Legal links',
      legal: 'Legal notice',
      privacy: 'Privacy',
      terms: 'Terms',
      merchant: 'Merchant agreement',
      acceptableUse: 'Acceptable use',
      contact: 'Contact: hello@ebda.app',
      byPrefix: 'A product of',
      draftNote: 'Legal documents version 1.0 · 2026-10-07.',
    },
    legalPages: LEGAL_EN,
  },
};
