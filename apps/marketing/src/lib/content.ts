import { BRAND } from '@force/shared/brand';
import { LEGAL_AR } from './legal-ar';
import { LEGAL_EN } from './legal-en';
import type { LegalPages } from './legal-types';
import type { Locale } from './site';

const CO = BRAND.company;

/** A payment or shipping provider; `logo` is a file in public/logos/ (none = our own icon). */
export interface Provider {
  name: string;
  logo?: string;
  icon?: 'cash' | 'truck';
}

export interface RingCopy {
  label: string;
  hint: string;
  metalLabel: string;
  stoneLabel: string;
  metals: { gold: string; white: string; rose: string };
  stones: { diamond: string; emerald: string; ruby: string };
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
  hero: {
    /** The brand line, «ابدأ — بابك لبدء مشروعك.» */
    brand: string;
    h1: string;
    sub: string;
    cta: string;
    secondary: string;
    slugLabel: string;
  };
  /** The /about page: company line, story heading, contact heading. */
  aboutPage: { title: string; company: string; storyH: string; contactH: string; desc: string };
  /** «حكاية ابدأ»: why the name and the open-door mark. */
  about: { title: string; paras: string[]; close: string; markLabel: string };
  /** The pinned scroll story: a store assembling inside a phone. */
  story: {
    title: string;
    steps: [string, string, string, string];
    /** The notification stream at the end of the story, oldest first. */
    toasts: { t: string; d: string }[];
    phoneLabel: string;
  };
  how: { title: string; steps: { t: string; d: string }[] };
  breakout: { title: string; words: [string, string, string] };
  dahab: { title: string; lead: string; ring: RingCopy };
  templates: {
    title: string;
    lead: string;
    devicesLabel: string;
  };
  features: { title: string; items: { t: string; d: string }[] };
  providers: {
    title: string;
    payLabel: string;
    pay: Provider[];
    shipLabel: string;
    ship: Provider[];
    activation: string;
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
  /** Footer contact block. */
  contact: { title: string; hello: string; security: string };
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
    about: string;
    /** Ownership + copyright line (company names come from BRAND.company). */
    ownership: string;
  };
  legalPages: LegalPages;
}

export const COPY: Record<Locale, Copy> = {
  ar: {
    meta: {
      title: 'ابدأ ستوديو للذكاء الاصطناعي — اعمل متجرك أونلاين في دقايق',
      description:
        'ابدأ ستور من ابدأ ستوديو للذكاء الاصطناعي — بابك لبدء مشروعك. اعمل متجرك أونلاين في دقايق: لينك باسمك، دفع أونلاين وكاش وإنستا باي، وشحن مع بوسطة وأرامكس.',
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
      brand: 'ابدأ ستوديو للذكاء الاصطناعي — بابك لبدء مشروعك.',
      h1: 'ابدأ متجرك أونلاين في دقايق.',
      sub: 'لينك باسمك، منتجاتك، وطلباتك. كله من موبايلك.',
      cta: 'ابدأ دلوقتي',
      secondary: 'شوف إزاي',
      slugLabel: 'لينك متجرك',
    },
    story: {
      title: 'متجرك بيتبني قدامك.',
      steps: ['اختار اسم ولوجو.', 'نزّل منتجاتك.', 'ظبّط ألوانك وصورك.', 'وأول طلب يوصلك.'],
      toasts: [
        { t: 'طلب جديد · 9,750 ج.م', d: 'سلسلة دهب · الدفع عند الاستلام' },
        { t: 'بوسطة استلمت الشحنة', d: 'الطلب رقم 1043 في الطريق للعميل' },
        { t: 'وصلك دفع إنستا باي', d: '18,500 ج.م من سارة م.' },
        { t: 'عميل جديد اشترك في النشرة', d: 'نهى اشتركت في عروض الأسبوع' },
      ],
      phoneLabel: 'متجر مجوهرات بيتبني على الموبايل، وبعدين توصله الطلبات والإشعارات.',
    },
    how: {
      title: '4 خطوات وتبدأ تبيع.',
      steps: [
        { t: 'سجّل وسمّي متجرك', d: 'إيميل وباسورد، واختار اللينك بتاعك.' },
        { t: 'نزّل منتجاتك', d: 'بالصور والأسعار والمقاسات، أو من ملف CSV.' },
        { t: 'اختار شكل متجرك', d: 'ألوانك وصورك، وكل حاجة فيه تتعدّل.' },
        { t: 'استقبل الطلبات', d: 'وتابع الدفع والشحن من موبايلك.' },
      ],
    },
    breakout: { title: 'منتجك هو البطل.', words: ['ابدأ', 'متجرك', 'دلوقتي'] },
    dahab: {
      title: 'شوفه لايف، من كل زاوية.',
      lead: 'لفّ الخاتم واختار المعدن والحجر. كده عميلك يشوف منتجك على متجرك.',
      ring: {
        label: 'خاتم سوليتير ثلاثي الأبعاد بيلف، تقدر تسحبه علشان تلفه',
        hint: 'اسحب علشان تلفّه',
        metalLabel: 'المعدن',
        stoneLabel: 'الحجر',
        metals: { gold: 'دهب أصفر', white: 'دهب أبيض', rose: 'روز جولد' },
        stones: { diamond: 'ألماظ', emerald: 'زمرد', ruby: 'ياقوت' },
      },
    },
    templates: {
      title: 'متجر واحد، على كل الشاشات.',
      lead: 'نفس المتجر على الموبايل والتابلت واللابتوب.',
      devicesLabel: 'متجر مجوهرات حقيقي على ابدأ ستور، على لابتوب وتابلت وموبايل',
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
        { name: 'Mylerz', logo: 'mylerz' },
        { name: 'Aramex', logo: 'aramex' },
        { name: 'توصيل بنفسك', icon: 'truck' },
      ],
      activation: 'تفعيل أي خدمة بياخد حوالي 5 ساعات.',
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
    aboutPage: {
      title: 'عن ابدأ ستوديو للذكاء الاصطناعي',
      desc: 'ابدأ ستور منصة تقنية لبناء المتاجر الإلكترونية للتجار في مصر، من ابدأ ستوديو للذكاء الاصطناعي.',
      company: `ابدأ ستور منصة تقنية لبناء المتاجر الإلكترونية للتجار في مصر، مملوكة ل${CO.shortNameAr} وتديرها.`,
      storyH: 'حكاية ابدأ ستوديو للذكاء الاصطناعي',
      contactH: 'تواصل معنا',
    },
    about: {
      title: 'حكاية ابدأ ستوديو للذكاء الاصطناعي',
      paras: [
        'كل مشروع بيبدأ قبل ما يبقى مشروع، بيبدأ بجملة: «عندي فكرة».',
        'وبين الفكرة وأول عميل فيه أبواب كتير: موقع، وطلبات، وكلام مع العملاء، ومنتجات، ودفع، وتوصيل، وتكنولوجيا.',
        'ابدأ ستوديو للذكاء الاصطناعي موجودة علشان تسهّل أول باب. علشان كده اللوجو باب، واللي جوّاه هو صاحب الفكرة، واقف على العتبة. مش محتاج يفهم في منصات التجارة الإلكترونية ولا الـ API ولا البنية التحتية ولا ربط واتساب. محتاج بس ياخد أول خطوة.',
      ],
      close: 'ابدأ.',
      markLabel: 'لوجو ابدأ ستوديو للذكاء الاصطناعي: باب مفتوح، وصاحب الفكرة بيعدّي منه',
    },
    contact: {
      title: 'تواصل معانا',
      hello: 'أسئلة واستفسارات',
      security: 'الإبلاغ عن ثغرة أمنية',
    },
    start: {
      title: 'الدور عليك.',
      lead: 'اعمل متجرك النهاردة، وابدأ تبيع بكرة.',
      firstMerchantLabel: 'أول تاجر على ابدأ ستور',
      cta: 'ابدأ دلوقتي',
      login: 'عندك متجر؟ ادخل',
    },
    footer: {
      product: `ابدأ ستور — منتج من ${CO.shortNameAr}`,
      legalNav: 'روابط قانونية',
      legal: 'الإشعار القانوني',
      privacy: 'الخصوصية',
      terms: 'الشروط',
      merchant: 'اتفاقية التاجر',
      acceptableUse: 'الاستخدام المقبول',
      contact: 'تواصل: ahlan@ebda.app',
      legalVersion: 'الإصدار 1.0 من الوثائق القانونية · 2026-10-07.',
      about: 'عن ابدأ ستوديو للذكاء الاصطناعي',
      ownership: `ابدأ ستور منتج من ${CO.shortNameAr}. © 2026 ${CO.shortNameAr}. جميع الحقوق محفوظة.`,
    },
    legalPages: LEGAL_AR,
  },
  en: {
    meta: {
      title: 'Ebda AI Studio — Open your store online in minutes',
      description:
        'Ebda Store, from Ebda AI Studio — Your doorway to business. Open your online store in minutes: your own link, online payments, cash and InstaPay, shipping with Bosta and Aramex.',
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
      brand: 'Ebda AI Studio — Your doorway to business.',
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
        'Tune your colours and photos.',
        'And the first order arrives.',
      ],
      toasts: [
        { t: 'New order · EGP 9,750', d: 'Gold chain · cash on delivery' },
        { t: 'Bosta picked up the parcel', d: 'Order 1043 is on its way' },
        { t: 'InstaPay payment received', d: 'EGP 18,500 from Sara M.' },
        { t: 'New newsletter subscriber', d: 'Noha joined this week’s offers' },
      ],
      phoneLabel:
        'A jewellery store being built on a phone, then receiving orders and notifications.',
    },
    how: {
      title: 'Four steps and you’re selling.',
      steps: [
        { t: 'Sign up and name your store', d: 'Email and password, then pick your link.' },
        { t: 'Add your products', d: 'Photos, prices and sizes, or a CSV file.' },
        { t: 'Pick your store’s look', d: 'Your colours and photos, everything editable.' },
        { t: 'Take orders', d: 'And follow payment and shipping from your phone.' },
      ],
    },
    breakout: { title: 'Your product is the star.', words: ['ابدأ', 'متجرك', 'دلوقتي'] },
    dahab: {
      title: 'See it live, from every angle.',
      lead: 'Turn the ring and pick the metal and stone. That’s how customers see your product.',
      ring: {
        label: 'A 3D solitaire ring turning; drag to spin it',
        hint: 'Drag to spin',
        metalLabel: 'Metal',
        stoneLabel: 'Stone',
        metals: { gold: 'Yellow gold', white: 'White gold', rose: 'Rose gold' },
        stones: { diamond: 'Diamond', emerald: 'Emerald', ruby: 'Ruby' },
      },
    },
    templates: {
      title: 'One store, on every screen.',
      lead: 'The same store on phone, tablet and laptop.',
      devicesLabel: 'A real jewellery store on Ebda Store, on a laptop, tablet and phone',
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
        { name: 'Mylerz', logo: 'mylerz' },
        { name: 'Aramex', logo: 'aramex' },
        { name: 'Your own delivery', icon: 'truck' },
      ],
      activation: 'Activation takes about 5 hours per service.',
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
    aboutPage: {
      title: 'About Ebda AI Studio',
      desc: 'Ebda Store is an online store builder for merchants in Egypt, a product of Ebda AI Studio.',
      company: `Ebda Store is an online store builder for merchants in Egypt, a technology platform owned and operated by ${CO.shortNameEn}.`,
      storyH: 'The Ebda AI Studio story',
      contactH: 'Contact',
    },
    about: {
      title: 'The Ebda AI Studio story',
      paras: [
        'Every business starts before it becomes a business. It starts with “I have an idea.”',
        'Between the idea and the first customer there are too many doors: a website, orders, talking to customers, products, payments, delivery, technology.',
        'Ebda AI Studio exists to make the first door simple. That’s why the logo is a doorway, and the shape inside is the person with the idea, standing at the entrance. They don’t need to know e-commerce platforms, APIs, infrastructure or WhatsApp integrations. They just take the first step.',
      ],
      close: 'ابدأ.',
      markLabel:
        'The Ebda AI Studio mark: an open doorway, with the person with the idea stepping through',
    },
    contact: {
      title: 'Contact us',
      hello: 'Questions and help',
      security: 'Report a security issue',
    },
    start: {
      title: 'Your turn.',
      lead: 'Set up your store today. Start selling tomorrow.',
      firstMerchantLabel: 'First merchant on Ebda Store',
      cta: 'Start now',
      login: 'Have a store? Log in',
    },
    footer: {
      product: `Ebda Store — a product of ${CO.shortNameEn}`,
      legalNav: 'Legal links',
      legal: 'Legal notice',
      privacy: 'Privacy',
      terms: 'Terms',
      merchant: 'Merchant agreement',
      acceptableUse: 'Acceptable use',
      contact: 'Contact: ahlan@ebda.app',
      legalVersion: 'Legal documents version 1.0 · 2026-10-07.',
      about: 'About Ebda AI Studio',
      ownership: `Ebda Store is a product of ${CO.shortNameEn}. © 2026 ${CO.shortNameEn}. All rights reserved.`,
    },
    legalPages: LEGAL_EN,
  },
};
