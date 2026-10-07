import { LEGAL_AR } from './legal-ar';
import { LEGAL_EN } from './legal-en';
import type { LegalPages } from './legal-types';
import type { Locale } from './site';

/** A payment or shipping provider; `logo` is a file in public/logos/ (none = our own icon). */
export interface Provider {
  name: string;
  logo?: string;
  /** The logo has white parts, so it sits on a dark plate. */
  dark?: boolean;
  icon?: 'cash' | 'truck';
}

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
    pay: Provider[];
    shipLabel: string;
    ship: Provider[];
    ask: string;
    askLink: string;
  };
  pricing: {
    title: string;
    lead: string;
    note: string;
    perMonth: string;
    annual: string;
    compareTitle: string;
    yes: string;
    no: string;
    trial: string;
    planCta: string;
    planCtaAnnual: string;
  };
  faq: { title: string; items: { q: string; a: string }[] };
  /** Footer contact block; `company` precedes the linked company name ("Ebda by Whisky 11"). */
  contact: { title: string; hello: string; security: string; company: string };
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
    legalVersion: string;
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
        { t: 'دومين باسمك', d: 'اربط دومينك، أو خليك على <اسمك>.ebda.app.' },
        { t: 'عربي وإنجليزي', d: 'متجرك ولوحة التحكم بالعربي من الأساس، ومعاهم إنجليزي.' },
      ],
    },
    providers: {
      title: 'الدفع والشحن، زي ما عملاءك متعودين.',
      payLabel: 'الدفع',
      pay: [
        { name: 'الدفع عند الاستلام', icon: 'cash' },
        { name: 'إنستا باي', logo: 'instapay' },
        { name: 'Paymob', logo: 'paymob' },
        { name: 'Kashier', logo: 'kashier' },
        { name: 'FawryPay', logo: 'fawrypay' },
      ],
      shipLabel: 'الشحن',
      ship: [
        { name: 'Bosta', logo: 'bosta' },
        { name: 'ShipBlu', logo: 'shipblu' },
        { name: 'Mylerz', logo: 'mylerz', dark: true },
        { name: 'Aramex', logo: 'aramex' },
        { name: 'توصيل بنفسك', icon: 'truck' },
      ],
      ask: 'محتاج شركة تانية؟',
      askLink: 'قولّنا',
    },
    pricing: {
      title: 'باقة على قد متجرك.',
      lead: 'جرّب باقة النمو 14 يوم ببلاش، ومن غير عمولة على طلباتك.',
      note: 'وفّر 25% لو دفعت سنوي. رسوم بوابات الدفع منفصلة.',
      perMonth: 'في الشهر',
      annual: 'سنوي',
      compareTitle: 'قارن الباقات',
      yes: 'متاح',
      no: 'مش متاح',
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
          q: 'الشحن بيشتغل إزاي؟',
          a: 'اربط بوسطة أو ShipBlu أو مايلرز أو أرامكس من لوحة التحكم، أو وصّل بنفسك.',
        },
        {
          q: 'فيه عمولة على الطلبات؟',
          a: 'لأ، 0% على كل الباقات. بتدفع الاشتراك بس، ورسوم بوابة الدفع لو العميل دفع أونلاين.',
        },
        {
          q: 'أقدر ألغي في أي وقت؟',
          a: 'أيوه، من صفحة الاشتراك في لوحة التحكم، والإلغاء بيسري في آخر المدة المدفوعة.',
        },
        {
          q: 'بياناتي بتاعة مين؟',
          a: 'بتاعتك. منتجاتك وطلباتك وعملاءك ملكك إنت.',
        },
      ],
    },
    contact: {
      title: 'تواصل معانا',
      hello: 'أسئلة واستفسارات',
      security: 'الإبلاغ عن ثغرة أمنية',
      company: 'ابدأ من',
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
      contact: 'تواصل: ahlan@ebda.app',
      legalVersion: 'الإصدار 1.0 من الوثائق القانونية · 2026-10-07.',
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
        {
          t: 'Your store in your pocket',
          d: 'The dashboard on your phone, with a ping for every order.',
        },
        { t: 'Your numbers', d: 'See what sells and what doesn’t.' },
        { t: 'VAT, handled', d: 'Registered for VAT? It’s calculated for you.' },
        { t: 'Orders on WhatsApp', d: 'Customers send you the order details in one tap.' },
        { t: 'Your own domain', d: 'Connect your domain, or stay on <you>.ebda.app.' },
        {
          t: 'Arabic and English',
          d: 'Your store and dashboard are Arabic first, with English too.',
        },
      ],
    },
    providers: {
      title: 'Payment and shipping, the way your customers expect.',
      payLabel: 'Payment',
      pay: [
        { name: 'Cash on delivery', icon: 'cash' },
        { name: 'InstaPay', logo: 'instapay' },
        { name: 'Paymob', logo: 'paymob' },
        { name: 'Kashier', logo: 'kashier' },
        { name: 'FawryPay', logo: 'fawrypay' },
      ],
      shipLabel: 'Shipping',
      ship: [
        { name: 'Bosta', logo: 'bosta' },
        { name: 'ShipBlu', logo: 'shipblu' },
        { name: 'Mylerz', logo: 'mylerz', dark: true },
        { name: 'Aramex', logo: 'aramex' },
        { name: 'Your own delivery', icon: 'truck' },
      ],
      ask: 'Need another provider?',
      askLink: 'Tell us',
    },
    pricing: {
      title: 'A plan that fits your store.',
      lead: 'Try Growth free for 14 days. No commission on your orders.',
      note: 'Save 25% when you pay yearly. Payment gateway fees are separate.',
      perMonth: 'a month',
      annual: 'yearly',
      compareTitle: 'Compare plans',
      yes: 'Included',
      no: 'Not included',
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
          q: 'How does shipping work?',
          a: 'Connect Bosta, ShipBlu, Mylerz or Aramex from your dashboard, or deliver yourself.',
        },
        {
          q: 'Is there a commission on orders?',
          a: 'No, 0% on every plan. You pay the subscription, plus gateway fees when a customer pays online.',
        },
        {
          q: 'Can I cancel anytime?',
          a: 'Yes, from the subscription page in your dashboard. It takes effect at the end of the paid period.',
        },
        {
          q: 'Who owns my data?',
          a: 'You do. Your products, orders and customers are yours.',
        },
      ],
    },
    contact: {
      title: 'Contact us',
      hello: 'Questions and help',
      security: 'Report a security issue',
      company: 'Ebda by',
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
      contact: 'Contact: ahlan@ebda.app',
      legalVersion: 'Legal documents version 1.0 · 2026-10-07.',
    },
    legalPages: LEGAL_EN,
  },
};
