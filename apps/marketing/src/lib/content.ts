import { BRAND } from '@ebda/shared/brand';
import {
  LEGAL_POLICIES,
  LEGAL_DOC_KEYS,
  currentLegalVersion,
  formatLegalDate,
} from '@ebda/shared/legal';
import { LEGAL_AR } from './legal-ar';
import { LEGAL_EN } from './legal-en';
import type { LegalPages } from './legal-types';
import { heroSavingAr, heroSavingEn } from './positioning';
import type { Locale } from './site';

const CO = BRAND.company;
const PN = BRAND.product;

/**
 * When any legal document last changed: the footer states this date only. No version: the five
 * documents version independently, so one number would be wrong for most pages (Ruling LEGAL-4).
 */
export const LEGAL_UPDATED = LEGAL_DOC_KEYS.map(
  key => currentLegalVersion(LEGAL_POLICIES, key).publishedAt
).reduce((a, b) => (b > a ? b : a));

/** A payment or shipping provider; `logo` is a file in public/logos/ (none = our own icon). */
export interface Provider {
  name: string;
  logo?: string;
  icon?: 'cash' | 'truck';
}

export interface StoryStep {
  t: string;
  d: string;
}

/** One vertical of the 3D section: a look's product page around a real 3D model. */
export interface Model3dVertical {
  name: string;
  kind: string;
  /** The demo product on the phone's product page (illustrative: no real shop). */
  product: { name: string; price: number; desc: string };
  /** Accessible name of the 3D canvas and alt of its still image. */
  alt: string;
  /** Colour names for the model's glTF variants (qamar, jasmine, dahab), by variant id. */
  variants?: Record<string, string>;
}

export interface Model3dCopy {
  title: string;
  lead: string;
  tablistLabel: string;
  /** Badge on the phone: the shop and product are illustrations. */
  badge: string;
  /** aria-label of the phone region. */
  pageLabel: string;
  /** Hint shown over the live model. */
  hint: string;
  ar: string;
  loading: string;
  error: string;
  /** Screen-reader only: how to turn the model from the keyboard. */
  keys: string;
  colourLabel: string;
  addToCart: string;
  /** Shown instead of the live model for reduced motion / Save-Data: a button that loads it. */
  load: string;
  qr: { title: string; hint: string; alt: string };
  footnote: string;
  verticals: Record<'qamar' | 'souq' | 'lamma' | 'jasmine' | 'dahab', Model3dVertical>;
}

/** The three hero features of the features section, each with a visual. */
export interface HeroFeatures {
  editor: {
    t: string;
    d: string;
    /** Visual: the editor's section list, a colour row, and the preview. */
    sectionsLabel: string;
    sections: string[];
    colourLabel: string;
    previewAlt: string;
  };
  orders: {
    t: string;
    d: string;
    /** Visual: a customer's WhatsApp order message and the push notification it triggers. */
    chatLabel: string;
    message: string[];
    send: string;
    pushT: string;
    pushD: string;
  };
}

export interface LookCopy {
  name: string;
  /** Who this look is for. */
  who: string;
  /** The bold idea behind it. */
  idea: string;
}

export interface LooksCopy {
  title: string;
  lead: string;
  tablistLabel: string;
  /** Badge on every phone: the photos and shops are illustrations. */
  badge: string;
  /** aria-label of the A/B/C look switch (phone width). */
  switchLabel: string;
  ideaLabel: string;
  loading: string;
  failed: string;
  retry: string;
  /** English page only: the phones stay Arabic. */
  bilingualNote: string;
  /** Templates with a live demo store (`DEMO_STORES`) link each look to it. */
  live: { link: string };
  /** Tab labels, in tab order: id matches /looks/<id>.html. */
  templates: { id: string; name: string; kind: string }[];
  /** The three looks (A, B, C) of each template. */
  items: Record<string, [LookCopy, LookCopy, LookCopy]>;
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
    looks: string;
    login: string;
    start: string;
    menu: string;
    switchTo: string;
    switchLabel: string;
    /** The Products menu (BRAND-ARCH-1): one entry per LIVE product; the others are added when they ship. */
    products: string;
    storeBlurb: string;
    /** The Ebda WhatsApp entry of the same menu (LAUNCH-SUITE-1). */
    whatsappBlurb: string;
    contact: string;
    /** The header's "More" menu (FAQ, About, Contact): keeps the top row to one line. */
    more: string;
    about: string;
  };
  hero: {
    h1: string;
    /** Names the product (BRAND.product), then what it gives you. */
    sub: string;
    /** Ruling POSITION-1: the eliminated monthly cost, from lib/positioning.ts. */
    saving: string;
    cta: string;
  };
  /** The /credits page (Ruling MKT-12): attribution for the third-party 3D models and the illustrative photos. */
  creditsPage: {
    title: string;
    desc: string;
    intro: string;
    modelsH: string;
    modelsLead: string;
    author: string;
    source: string;
    license: string;
    changes: string;
    triangles: string;
    use: string;
    photosH: string;
    photosP: string;
    modified: string;
  };
  /** The /about page: company line, story heading, contact heading. */
  aboutPage: {
    title: string;
    company: string;
    /** The studio's line, «ابدأ — بابك لبدء مشروعك.» (moved off the home hero, MKT-1). */
    brandLine: string;
    storyH: string;
    contactH: string;
    desc: string;
  };
  /** The /contact page (6c): every way to reach Ebda AI Studio, one line each. */
  contactPage: {
    title: string;
    desc: string;
    lead: string;
    emailH: string;
    emailP: string;
    whatsappH: string;
    whatsappP: string;
    helpH: string;
    helpP: string;
    helpLink: string;
    statusLink: string;
    securityH: string;
    securityP: string;
    company: string;
  };
  /** «حكاية ابدأ»: why the name and the open-door mark (shown on /about). */
  about: { title: string; paras: string[]; close: string };
  /** The pinned scroll story: the Dahab store assembling inside a phone, one frame per step. */
  story: {
    title: string;
    /** The four steps in order: what you do, and the one line that says how. */
    steps: [StoryStep, StoryStep, StoryStep, StoryStep];
    /** The notification stream at the end of the story, oldest first. */
    toasts: { t: string; d: string }[];
    phoneLabel: string;
  };
  /** The product page running a real 3D model (the same viewer merchants get), per vertical. */
  model3d: Model3dCopy;
  /** The interactive template + look picker (5 templates x 3 looks, phone previews). */
  looks: LooksCopy;
  features: {
    title: string;
    hero: HeroFeatures;
    /** The rest of the features: a compact list. */
    items: { t: string; d: string }[];
  };
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
    /** Legend of the phone-width plan switcher (screen readers). */
    pickLabel: string;
    yes: string;
    no: string;
    trial: string;
    planCta: string;
    planCtaAnnual: string;
  };
  faq: { title: string; items: { q: string; a: string }[] };
  /** The public WhatsApp line (number comes from BRAND.contact.whatsapp). */
  whatsapp: {
    /** Visible link label next to the icon. */
    label: string;
    /** aria-label of the icon-only header link; the number is appended. */
    aria: string;
    /** One line under the FAQ; ends before the link. */
    faq: string;
    /** One line in the closing section; ends before the link. */
    close: string;
  };
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
    cookies: string;
    terms: string;
    merchant: string;
    acceptableUse: string;
    /** Footer link to /legal/data-deletion. */
    dataDeletion: string;
    contact: string;
    legalVersion: string;
    about: string;
    /** Footer link to /credits. */
    credits: string;
    /** Ownership + copyright line (company names come from BRAND.company). */
    ownership: string;
  };
  legalPages: LegalPages;
}

export const COPY: Record<Locale, Copy> = {
  ar: {
    meta: {
      title: `${PN.nameAr} — اعمل متجرك أونلاين في دقايق`,
      description:
        'ابدأ ستور من ابدأ استوديو للذكاء الاصطناعي — بابك لبدء مشروعك. اعمل متجرك أونلاين في دقايق: لينك باسمك، دفع أونلاين وكاش وإنستا باي، وشحن مع بوسطة وأرامكس.',
    },
    skip: 'روح للمحتوى',
    nav: {
      label: 'التنقل الرئيسي',
      features: 'المميزات',
      solutions: 'إزاي بيشتغل',
      pricing: 'الأسعار',
      resources: 'أسئلة',
      looks: 'القوالب',
      login: 'دخول',
      start: 'ابدأ دلوقتي',
      menu: 'القائمة',
      switchTo: 'English',
      switchLabel: 'Switch to English',
      products: 'المنتجات',
      storeBlurb: 'متجرك أونلاين في دقايق',
      whatsappBlurb: 'كلّم عملاءك على واتساب من مكان واحد',
      contact: 'تواصل معنا',
      more: 'المزيد',
      about: 'عن الاستوديو',
    },
    hero: {
      h1: 'ابدأ متجرك أونلاين في دقايق.',
      sub: `${PN.nameAr} بيديك لينك باسمك، ومنتجاتك، وطلباتك. كله من موبايلك.`,
      saving: heroSavingAr(PN.nameAr),
      cta: 'ابدأ دلوقتي',
    },
    model3d: {
      title: 'خلّي عميلك يقلّب المنتج بإيده.',
      lead: 'ارفع موديل 3D لمنتجك، وعميلك يلفّه ويغيّر لونه ويشوفه في أوضته، من صفحة المنتج على متجرك.',
      tablistLabel: 'اختار شكل المتجر',
      badge: 'صور توضيحية',
      pageLabel: 'صفحة منتج على متجر تجريبي، بموديل 3D بيلف',
      hint: 'اسحب عشان تلفّه',
      ar: 'شوفه في مكانك',
      loading: 'بنحمّل الموديل...',
      error: 'الموديل ماحمّلش. جرّب تاني.',
      keys: 'اضغط على الموديل واستعمل الأسهم عشان تلفّه، وزرار + و- للتقريب.',
      colourLabel: 'اللون',
      addToCart: 'أضف للسلة',
      load: 'شغّل الموديل 3D',
      qr: {
        title: 'شوفه في أوضتك',
        hint: 'وجّه كاميرا موبايلك على الكود، واضغط «شوفه في مكانك».',
        alt: 'كود QR بيفتح موديل {name} على موبايلك',
      },
      footnote: 'متاح في كل الباقات.',
      verticals: {
        qamar: {
          name: 'قمر',
          kind: 'أزياء وأحذية',
          product: {
            name: 'كوتشي قمر اليومي',
            price: 1450,
            desc: 'خفيف ومريح لليوم كله، ومتاح بـ3 ألوان.',
          },
          alt: 'موديل 3D لكوتشي رياضي، اسحب عشان تلفّه',
          variants: { midnight: 'أزرق', beach: 'وردي', street: 'أسود' },
        },
        souq: {
          name: 'سوق',
          kind: 'تجزئة وهدايا',
          product: {
            name: 'فانوس نحاس مشغول',
            price: 890,
            desc: 'نحاس مشغول بإيد صنايعي، بينوّر الأوضة من غير ما يزحمها.',
          },
          alt: 'موديل 3D لفانوس نحاس، اسحب عشان تلفّه',
        },
        lamma: {
          name: 'لمّة',
          kind: 'البيت والمطبخ',
          product: {
            name: 'حلة فخار بغطاها',
            price: 380,
            desc: 'فخار مزجّج بيسوّي الأكل على نار هادية، وبيحافظ على سخونته على السفرة.',
          },
          alt: 'موديل 3D لحلة فخار بغطاها، اسحب عشان تلفّها',
        },
        jasmine: {
          name: 'ياسمين',
          kind: 'جمال وعناية بالبشرة',
          product: {
            name: 'سيروم ياسمين 30 مل',
            price: 420,
            desc: 'سيروم خفيف بقطّارة، ومتاح بـ3 ألوان.',
          },
          alt: 'موديل 3D لزجاجة سيروم بقطّارة، اسحب عشان تلفّها',
          variants: { rose: 'وردي', amber: 'عنبري', sage: 'أخضر مريمية' },
        },
        dahab: {
          name: 'دهب',
          kind: 'مجوهرات وهدايا',
          product: {
            name: 'خاتم سوليتير',
            price: 14500,
            desc: 'خاتم رفيع بحجر واحد، ومتاح بـ3 درجات دهب.',
          },
          alt: 'موديل 3D لخاتم سوليتير، اسحب عشان تلفّه',
          variants: { 'yellow-gold': 'دهب أصفر', 'rose-gold': 'دهب روز', 'white-gold': 'دهب أبيض' },
        },
      },
    },
    story: {
      title: 'متجرك بيتبني قدامك.',
      steps: [
        { t: 'اختار اسم ولوجو.', d: 'سجّل بإيميل وباسورد، واختار اللينك بتاعك.' },
        { t: 'نزّل منتجاتك.', d: 'بالصور والأسعار والمقاسات، أو من ملف إكسل.' },
        { t: 'ظبّط ألوانك وصورك.', d: 'اختار شكل متجرك، وكل حاجة فيه تتعدّل.' },
        { t: 'وأول طلب يوصلك.', d: 'وتابع الدفع والشحن من موبايلك.' },
      ],
      toasts: [
        { t: 'طلب جديد · 9,800 ج.م', d: 'إنسيال دهب رفيع · الدفع عند الاستلام' },
        { t: 'بوسطة استلمت الشحنة', d: 'الطلب رقم 1043 في الطريق للعميل' },
        { t: 'وصلك دفع إنستا باي', d: '18,500 ج.م من سارة م.' },
        { t: 'عميل جديد اشترك في النشرة', d: 'نهى اشتركت في عروض الأسبوع' },
      ],
      phoneLabel:
        'متجر مجوهرات (قالب دهب) بيتبني على الموبايل: اسم ولوجو، منتجات، ألوان وصور، وبعدين توصله الطلبات والإشعارات. صور توضيحية.',
    },
    looks: {
      title: 'اختار قالب، وبعدين اختار شكله.',
      lead: '5 قوالب، وكل قالب بـ3 أشكال. لفّ جوه أي موبايل واضغط على الفلاتر زي ما عميلك هيعمل. وبعد ما تختار، المحرر بيغيّر لك أي حاجة.',
      tablistLabel: 'القوالب',
      badge: 'صور توضيحية',
      switchLabel: 'الشكل',
      ideaLabel: 'الفكرة',
      loading: 'بنحمّل القالب...',
      failed: 'القالب ماحمّلش.',
      retry: 'جرّب تاني',
      bilingualNote: '',
      live: { link: 'افتح المتجر الحي' },
      templates: [
        { id: 'qamar', name: 'قمر', kind: 'أزياء وبوتيكات' },
        { id: 'souq', name: 'سوق', kind: 'تجزئة وإلكترونيات' },
        { id: 'jasmine', name: 'ياسمين', kind: 'جمال وعناية بالبشرة' },
        { id: 'lamma', name: 'لمّة', kind: 'أكل بيت ومطابخ منزلية' },
        { id: 'dahab', name: 'دهب', kind: 'مجوهرات وهدايا وشغل إيد' },
      ],
      items: {
        qamar: [
          {
            name: 'أتيليه',
            who: 'لبوتيك عايز هدومه تتكلم لوحدها: هادي وأبيض وبشكل مجلات.',
            idea: 'صور منتجات كبيرة وتقريبًا من غير زحمة: الهدوم هي الواجهة.',
          },
          {
            name: 'لوك بوك',
            who: 'للستايليست ومحلات الموضة السريعة اللي بتبيع إطلالات مش قطع لوحدها.',
            idea: 'اشتري الإطلالة كلها: كل لوك فيه قطعه وأسعاره، وبضغطة واحدة تضيفهم كلهم.',
          },
          {
            name: 'فيترين',
            who: 'لملابس المناسبات (فرح وخطوبة وسهرة) اللي المناسبة هي اللي بتحدد الشراء.',
            idea: 'التنقل بالمناسبة: فرح، خطوبة، سهرة، وكل واحدة بألوانها.',
          },
        ],
        souq: [
          {
            name: 'كتالوج',
            who: 'لمحل فيه أصناف كتير والزبون جاي عارف عايز إيه.',
            idea: 'توصل للي عايزه في ضغطتين: البحث والأقسام قبل أي صورة كبيرة.',
          },
          {
            name: 'سوق الليل',
            who: 'لتاجر عايز دفا وشخصية مش جدول مواصفات.',
            idea: 'سوق حيّ ومنوّر من غير زحمة، والبرتقاني محجوز للعروض بس.',
          },
          {
            name: 'شو روم',
            who: 'لمجموعة صغيرة فاخرة (موبايلات، لابتوبات) بتتباع قطعة قطعة.',
            idea: 'المنتج هو البطل، قطعة واحدة في كل شاشة، وزرار مقارنة.',
          },
        ],
        jasmine: [
          {
            name: 'عطارة',
            who: 'للعناية الطبيعية والتراثية اللي الثقة فيها جاية من اللي جواها.',
            idea: 'المكونات الأول: إيه اللي جواه، وبعدين المنتج.',
          },
          {
            name: 'بلوم',
            who: 'للمكياج الملوّن والجمهور الشاب اللي بيشتري بالدرجة.',
            idea: 'لون المنتج هو لون الصفحة، ودرجات اللون في كل حتة.',
          },
          {
            name: 'كلينك',
            who: 'للمنتجات الفعّالة بأسلوب دكاترة الجلدية، والعميل جاي بمشكلة عايز يحلها.',
            idea: 'الروتين هو التنقل: نضّف، عالج، احمي.',
          },
        ],
        lamma: [
          {
            name: 'سفرة العيلة',
            who: 'لمطبخ بيتي بيستلم طلبات في نفس اليوم زي منيو مطعم.',
            idea: 'اطلب زي المنيو مش زي المحل: تابات وأحجام وأزرار إضافة كبيرة.',
          },
          {
            name: 'كراسة المطبخ',
            who: 'لطباخة واحدة معروفة بوشها وحكايتها هي البراند.',
            idea: 'الطباخة هي البراند: حجز مسبق باليوم، والأطباق بتتحكي كحكايات.',
          },
          {
            name: 'السوق الطازج',
            who: 'للبقالة وتوصيل الخضار والفاكهة اللي الطلب المتكرر فيها هو الأساس.',
            idea: 'كل حاجة في ضغطتين، وممرات بألوان وإجمالي السلة بيتحدّث لحظيًا.',
          },
        ],
        dahab: [
          {
            name: 'على الجلد',
            who: 'لصايغ دهب زباينه بيقلقوا من المقاس والعيار قبل ما يحبوا القطعة.',
            idea: 'مش معروض، لابسه: كل صورة على الجلد، والمقاس والعيار ظاهرين على طول.',
          },
          {
            name: 'الورشة',
            who: 'لاستوديو فضة شغل إيد صنعته هي سبب إنك تدفع أكتر.',
            idea: 'الصنعة هي المنتج: رسم وصب وتلميع فعلي، ومدة التنفيذ على كل قطعة.',
          },
          {
            name: 'علبة الهدية',
            who: 'لمشتري الهدايا اللي بيبدأ من الشخص اللي بيهاديه وميزانيته.',
            idea: 'تسوّق بالشخص والميزانية، والتغليف والكارت ظاهرين قبل الدفع.',
          },
        ],
      },
    },
    features: {
      title: 'كل اللي محتاجه عشان تبيع.',
      hero: {
        editor: {
          t: 'عدّل متجرك زي ما تحب',
          d: 'غيّر الألوان والصور والأقسام، وشوف التغيير قدامك على طول. من غير مبرمج.',
          sectionsLabel: 'أقسام الصفحة',
          sections: ['الغلاف', 'الأقسام', 'المنتجات', 'آراء العملاء'],
          colourLabel: 'لون المتجر',
          previewAlt: 'معاينة صفحة متجر بتتغيّر مع كل تعديل في المحرر',
        },
        orders: {
          t: 'تأكيد الطلب على واتساب',
          d: 'بعد الطلب بالدفع عند الاستلام، العميل يبعتلك رسالة جاهزة بتفاصيل طلبه بضغطة زرار. وبييجيلك إشعار على موبايلك مع كل طلب جديد.',
          chatLabel: 'رسالة تأكيد طلب جاهزة على واتساب',
          message: [
            'طلب جديد من المتجر',
            'كوتشي قمر اليومي × 1',
            'الإجمالي: 1,450 ج.م',
            'الدفع عند الاستلام',
          ],
          send: 'أكّد على واتساب',
          pushT: 'طلب جديد · 1,450 ج.م',
          pushD: 'الدفع عند الاستلام',
        },
      },
      items: [
        { t: 'الضريبة محسوبة', d: 'لو مسجّل ضريبيًا، القيمة المضافة بتتحسب لوحدها.' },
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
      activation: 'بتربط أي خدمة بحسابك إنت، وبنتأكد منها أول ما تحفظ.',
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
      pickLabel: 'اختار الباقة',
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
          a: 'بتاعتك. منتجاتك وطلباتك وعملاؤك ملكك إنت.',
        },
      ],
    },
    creditsPage: {
      title: 'حقوق الصور والموديلات',
      desc: 'الموديلات ثلاثية الأبعاد والصور اللي في ابدأ ستور، ومين عملها وتحت أي رخصة استخدام، عشان حق كل صاحب شغل يتحفظ.',
      intro:
        'المتاجر اللي بتشوفها على الموقع أمثلة توضيحية. الموديلات ثلاثية الأبعاد اللي في صفحة المنتج مأخوذة من مصادر مفتوحة، وده نسبها كاملة.',
      modelsH: 'موديلات 3D',
      modelsLead: 'كل موديل اتظبط عشان يشتغل خفيف على الموقع. التعديلات مكتوبة قدام كل واحد.',
      author: 'صاحب الموديل',
      source: 'المصدر',
      license: 'الرخصة',
      changes: 'التعديلات',
      triangles: 'المثلثات',
      use: 'بيظهر في',
      photosH: 'صور القوالب',
      photosP:
        'الصور في القوالب الخمسة وأشكالها الخمستاشر اتعملت بالذكاء الاصطناعي عشان توضيح الفكرة. مش بتعرض أي محل أو منتج أو شخص حقيقي ومش محتاجة نسب.',
      modified: 'معدّل',
    },
    aboutPage: {
      title: 'عن ابدأ استوديو للذكاء الاصطناعي',
      desc: 'ابدأ ستور منصة تقنية لبناء المتاجر الإلكترونية للتجار في مصر، من ابدأ استوديو للذكاء الاصطناعي، بالعربي أولًا وبواجهة بسيطة.',
      brandLine: 'ابدأ استوديو للذكاء الاصطناعي — بابك لبدء مشروعك.',
      company: `ابدأ ستور منصة تقنية لبناء المتاجر الإلكترونية للتجار في مصر، مملوكة ل${CO.shortNameAr} وتديرها.`,
      storyH: 'حكاية ابدأ استوديو للذكاء الاصطناعي',
      contactH: 'تواصل معنا',
    },
    contactPage: {
      title: 'تواصل مع ابدأ استوديو للذكاء الاصطناعي',
      desc: 'إيميل وواتساب ومركز المساعدة والإبلاغ عن ثغرة أمنية، كل طرق التواصل مع ابدأ استوديو للذكاء الاصطناعي في مكان واحد.',
      lead: 'اكتب لنا بالطريقة اللي تريّحك، وهنرد عليك.',
      emailH: 'إيميل',
      emailP: 'للأسئلة والاستفسارات والشراكات.',
      whatsappH: 'واتساب',
      whatsappP: 'لأسئلة قبل ما تبدأ متجرك.',
      helpH: 'محتاج مساعدة في متجرك؟',
      helpP: 'الإجابات المكتوبة وحالة الخدمة أسرع من أي رد.',
      helpLink: 'مركز المساعدة',
      statusLink: 'حالة الخدمة',
      securityH: 'الإبلاغ عن ثغرة أمنية',
      securityP: 'راسلنا على الإيميل ده وهنتعامل معاه بجدية. التفاصيل في ملف security.txt.',
      company: `ابدأ ستور منتج من ${CO.legalNameAr}.`,
    },
    about: {
      title: 'حكاية ابدأ استوديو للذكاء الاصطناعي',
      paras: [
        'كل مشروع بيبدأ قبل ما يبقى مشروع، بيبدأ بجملة: «عندي فكرة».',
        'وبين الفكرة وأول عميل فيه أبواب كتير: موقع، وطلبات، وكلام مع العملاء، ومنتجات، ودفع، وتوصيل، وتكنولوجيا.',
        'ابدأ استوديو للذكاء الاصطناعي موجودة عشان تسهّل أول باب. عشان كده اللوجو باب، واللي جوّاه هو صاحب الفكرة، واقف على العتبة. مش محتاج يفهم في منصات التجارة الإلكترونية ولا الـ API ولا البنية التحتية ولا ربط واتساب. محتاج بس ياخد أول خطوة.',
      ],
      close: 'ابدأ.',
    },
    whatsapp: {
      label: 'واتساب',
      aria: 'كلمنا على واتساب',
      faq: 'لسه عندك سؤال؟ كلمنا على واتساب وهنرد عليك:',
      close: 'محتاج تسأل قبل ما تبدأ؟ كلمنا على واتساب:',
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
      cookies: 'إعدادات الكوكيز',
      terms: 'الشروط',
      merchant: 'اتفاقية التاجر',
      acceptableUse: 'الاستخدام المقبول',
      dataDeletion: 'حذف البيانات',
      contact: 'تواصل: ahlan@ebda.app',
      legalVersion: `آخر تحديث للوثائق القانونية: ${formatLegalDate(LEGAL_UPDATED, 'ar')}.`,
      about: 'عن ابدأ استوديو للذكاء الاصطناعي',
      credits: 'حقوق الصور والموديلات',
      ownership: `ابدأ ستور منتج من ${CO.shortNameAr}. © 2026 ${CO.shortNameAr}. جميع الحقوق محفوظة.`,
    },
    legalPages: LEGAL_AR,
  },
  en: {
    meta: {
      title: `${PN.nameEn} — Open your store online in minutes`,
      description:
        'Ebda Store, from Ebda AI Studio: open your online store in minutes with your own link, online payments, cash and InstaPay, and shipping with Bosta and Aramex.',
    },
    skip: 'Skip to content',
    nav: {
      label: 'Main navigation',
      features: 'Features',
      solutions: 'How it works',
      pricing: 'Pricing',
      resources: 'FAQ',
      looks: 'Templates',
      login: 'Log in',
      start: 'Start now',
      menu: 'Menu',
      switchTo: 'العربية',
      switchLabel: 'التبديل إلى العربية',
      products: 'Products',
      storeBlurb: 'Your online store in minutes',
      whatsappBlurb: 'Talk to your customers on WhatsApp, from one inbox',
      contact: 'Contact',
      more: 'More',
      about: 'About the studio',
    },
    hero: {
      h1: 'Open your online store in minutes.',
      sub: `${PN.nameEn} gives you your own link, products and orders. All from your phone.`,
      saving: heroSavingEn(),
      cta: 'Start now',
    },
    model3d: {
      title: 'Let shoppers turn it in their hands.',
      lead: 'Upload a 3D model and customers spin it, switch colours and place it in their room, right on your product page.',
      tablistLabel: 'Pick a store look',
      badge: 'Illustrative',
      pageLabel: 'A product page on a demo store, with a turning 3D model',
      hint: 'Drag to turn',
      ar: 'View in your space',
      loading: 'Loading the model...',
      error: 'The model did not load. Try again.',
      keys: 'Focus the model and use the arrow keys to turn it, and + and - to zoom.',
      colourLabel: 'Colour',
      addToCart: 'Add to cart',
      load: 'Load the 3D model',
      qr: {
        title: 'See it in your room',
        hint: 'Point your phone camera at the code, then tap “View in your space”.',
        alt: 'QR code that opens the {name} model on your phone',
      },
      footnote: 'Included on every plan.',
      verticals: {
        qamar: {
          name: 'Qamar',
          kind: 'Fashion and shoes',
          product: {
            name: 'Qamar everyday sneaker',
            price: 1450,
            desc: 'Light and comfortable all day, in three colours.',
          },
          alt: '3D model of a sneaker; drag to turn it',
          variants: { midnight: 'Blue', beach: 'Rose', street: 'Black' },
        },
        souq: {
          name: 'Souq',
          kind: 'Retail and gifts',
          product: {
            name: 'Worked brass lantern',
            price: 890,
            desc: 'Hand-worked brass that lights a room without crowding it.',
          },
          alt: '3D model of a brass lantern; drag to turn it',
        },
        lamma: {
          name: 'Lamma',
          kind: 'Home and kitchen',
          product: {
            name: 'Lidded clay pot',
            price: 380,
            desc: 'Glazed earthenware that cooks slowly and keeps the food hot at the table.',
          },
          alt: '3D model of a lidded clay cooking pot; drag to turn it',
        },
        jasmine: {
          name: 'Jasmine',
          kind: 'Beauty and skincare',
          product: {
            name: 'Jasmine serum 30 ml',
            price: 420,
            desc: 'A light serum with a dropper, in 3 colours.',
          },
          alt: '3D model of a dropper serum bottle; drag to turn it',
          variants: { rose: 'Rose', amber: 'Amber', sage: 'Sage' },
        },
        dahab: {
          name: 'Dahab',
          kind: 'Jewellery and gifts',
          product: {
            name: 'Solitaire ring',
            price: 14500,
            desc: 'A slim ring with a single stone, in 3 shades of gold.',
          },
          alt: '3D model of a solitaire ring; drag to turn it',
          variants: {
            'yellow-gold': 'Yellow gold',
            'rose-gold': 'Rose gold',
            'white-gold': 'White gold',
          },
        },
      },
    },
    story: {
      title: 'Watch your store come together.',
      steps: [
        { t: 'Pick a name and logo.', d: 'Sign up with email and password, then pick your link.' },
        { t: 'Add your products.', d: 'Photos, prices and sizes, or an Excel file.' },
        { t: 'Tune your colours and photos.', d: 'Pick your store’s look, everything editable.' },
        { t: 'And the first order arrives.', d: 'Follow payment and shipping from your phone.' },
      ],
      toasts: [
        { t: 'New order · EGP 9,800', d: 'Slim gold bangle · cash on delivery' },
        { t: 'Bosta picked up the parcel', d: 'Order 1043 is on its way' },
        { t: 'InstaPay payment received', d: 'EGP 18,500 from Sara M.' },
        { t: 'New newsletter subscriber', d: 'Noha joined this week’s offers' },
      ],
      phoneLabel:
        'A jewellery store (the Dahab template) being built on a phone: name and logo, products, colours and photos, then orders and notifications. Illustrative.',
    },
    looks: {
      title: 'Pick a template, then pick its look.',
      lead: '5 templates, 3 looks each. Scroll inside any phone and tap the filters the way your customers will. Once you choose, the editor changes anything.',
      tablistLabel: 'Templates',
      badge: 'Illustrative',
      switchLabel: 'Look',
      ideaLabel: 'Bold idea',
      loading: 'Loading the template...',
      failed: 'The template did not load.',
      retry: 'Try again',
      bilingualNote:
        'Every template ships in Arabic and English. The previews here are shown in Arabic.',
      live: { link: 'Open the live store' },
      templates: [
        { id: 'qamar', name: 'Qamar', kind: 'Fashion and boutiques' },
        { id: 'souq', name: 'Souq', kind: 'General retail and electronics' },
        { id: 'jasmine', name: 'Jasmine', kind: 'Beauty and skincare' },
        { id: 'lamma', name: 'Lamma', kind: 'Home food and home kitchens' },
        { id: 'dahab', name: 'Dahab', kind: 'Jewellery, handmade and gifts' },
      ],
      items: {
        qamar: [
          {
            name: 'Atelier',
            who: 'For a boutique whose clothes should speak alone: calm, white, editorial.',
            idea: 'Oversized product photography with almost no chrome: the clothes are the interface.',
          },
          {
            name: 'Lookbook',
            who: 'For stylists and fast-fashion shops that sell outfits, not single pieces.',
            idea: 'Shop the whole outfit: each look carries its items and prices, one tap adds the lot.',
          },
          {
            name: 'Vitrine',
            who: 'For occasion wear (weddings, engagements, evenings) where the event decides the purchase.',
            idea: 'Occasion-first navigation: wedding, engagement, evening, each on its own palette band.',
          },
        ],
        souq: [
          {
            name: 'Catalogue',
            who: 'For a shop with many SKUs where shoppers arrive knowing what they want.',
            idea: 'Find it in two taps: search and categories come before any hero.',
          },
          {
            name: 'Night souq',
            who: 'For a retailer who wants warmth and personality, not a spec sheet.',
            idea: 'A market that feels lit and alive without clutter; orange is reserved for deals only.',
          },
          {
            name: 'Showroom',
            who: 'For a small, premium range (phones, laptops) sold one object at a time.',
            idea: 'Product as hero, one object per screen, with a compare toggle.',
          },
        ],
        jasmine: [
          {
            name: 'Apothecary',
            who: 'For natural and heritage skincare where trust comes from what is inside.',
            idea: 'Ingredients first: what is in it, then the product.',
          },
          {
            name: 'Bloom',
            who: 'For colour cosmetics and a young audience that shops by shade.',
            idea: 'The colour of the product is the colour of the page; shade swatches everywhere.',
          },
          {
            name: 'Clinic',
            who: 'For dermatologist-style actives where the shopper has a concern to solve.',
            idea: 'The routine is the navigation: cleanse, treat, protect.',
          },
        ],
        lamma: [
          {
            name: 'Family table',
            who: 'For a home kitchen that takes same-day orders like a restaurant menu.',
            idea: 'Order like a menu, not like a shop: tabs, portions, big add buttons.',
          },
          {
            name: 'Kitchen notebook',
            who: 'For a single named cook whose face and story are the brand.',
            idea: 'The cook is the brand: pre-order by day, dishes told as stories.',
          },
          {
            name: 'Fresh market',
            who: 'For grocery and produce delivery where repeat baskets matter.',
            idea: 'Everything in two taps, with colour-coded aisles and a live cart total.',
          },
        ],
        dahab: [
          {
            name: 'Worn',
            who: 'For a gold jeweller whose customers worry about size and karat before they fall in love.',
            idea: 'Worn, not displayed: every photo is on skin, and size and karat are always visible.',
          },
          {
            name: 'Workshop',
            who: 'For a handmade silver studio whose craft is the reason to pay more.',
            idea: 'The making is the product: a real draw, cast, polish sequence and a lead time on every piece.',
          },
          {
            name: 'Gift box',
            who: 'For gift buyers who start from who it is for and how much they can spend.',
            idea: 'Shop by recipient and budget, with the wrapping and card visible before checkout.',
          },
        ],
      },
    },
    features: {
      title: 'Everything you need to sell.',
      hero: {
        editor: {
          t: 'Edit your store your way',
          d: 'Change colours, photos and sections, and watch it update live. No developer needed.',
          sectionsLabel: 'Page sections',
          sections: ['Cover', 'Categories', 'Products', 'Reviews'],
          colourLabel: 'Store colour',
          previewAlt: 'A store page preview that changes with every edit in the editor',
        },
        orders: {
          t: 'Order confirmation on WhatsApp',
          d: 'After a cash-on-delivery order, the customer sends you a ready-made message with their order details in one tap. Your phone also pings for every new order.',
          chatLabel: 'A ready-made WhatsApp order confirmation',
          message: [
            'New order from the store',
            'Qamar everyday sneaker × 1',
            'Total: EGP 1,450',
            'Cash on delivery',
          ],
          send: 'Confirm on WhatsApp',
          pushT: 'New order · EGP 1,450',
          pushD: 'Cash on delivery',
        },
      },
      items: [
        { t: 'VAT, handled', d: 'Registered for VAT? It’s calculated for you.' },
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
      activation: 'Connect any service with your own account; we check it the moment you save.',
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
      pickLabel: 'Choose a plan',
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
    creditsPage: {
      title: 'Credits',
      desc: 'The 3D models and images on Ebda Store: who made them and under which licence, so every creator gets the credit they are due.',
      intro:
        'The stores you see on this site are illustrations. The 3D models on the product page come from openly licensed sources; here is the full attribution.',
      modelsH: '3D models',
      modelsLead:
        'Each model was optimised to load fast on the web. The changes are listed beside each one.',
      author: 'Author',
      source: 'Source',
      license: 'Licence',
      changes: 'Changes',
      triangles: 'Triangles',
      use: 'Shown in',
      photosH: 'Template photos',
      photosP:
        'The photos in the five templates and their fifteen looks are AI-generated to illustrate the idea. They show no real shop, product or person and need no attribution.',
      modified: 'modified',
    },
    aboutPage: {
      title: 'About Ebda AI Studio',
      desc: 'Ebda Store is an online store builder for merchants in Egypt, a product of Ebda AI Studio: Arabic first, simple, and built for the local market.',
      brandLine: 'Ebda AI Studio — Your doorway to business.',
      company: `Ebda Store is an online store builder for merchants in Egypt, a technology platform owned and operated by ${CO.shortNameEn}.`,
      storyH: 'The Ebda AI Studio story',
      contactH: 'Contact',
    },
    contactPage: {
      title: 'Contact Ebda AI Studio',
      desc: 'Email, WhatsApp, the help centre and security reports: every way to reach Ebda AI Studio in one place.',
      lead: 'Write to us the way that suits you, and we will reply.',
      emailH: 'Email',
      emailP: 'Questions, enquiries and partnerships.',
      whatsappH: 'WhatsApp',
      whatsappP: 'Questions before you start your store.',
      helpH: 'Need help with your store?',
      helpP: 'The written answers and the service status are faster than any reply.',
      helpLink: 'Help centre',
      statusLink: 'Service status',
      securityH: 'Report a security issue',
      securityP:
        'Write to this address and we will treat it seriously. Details are in our security.txt.',
      company: `Ebda Store is a product of ${CO.legalNameEn}.`,
    },
    about: {
      title: 'The Ebda AI Studio story',
      paras: [
        'Every business starts before it becomes a business. It starts with “I have an idea.”',
        'Between the idea and the first customer there are too many doors: a website, orders, talking to customers, products, payments, delivery, technology.',
        'Ebda AI Studio exists to make the first door simple. That’s why the logo is a doorway, and the shape inside is the person with the idea, standing at the entrance. They don’t need to know e-commerce platforms, APIs, infrastructure or WhatsApp integrations. They just take the first step.',
      ],
      close: 'ابدأ.',
    },
    whatsapp: {
      label: 'WhatsApp',
      aria: 'Chat with us on WhatsApp',
      faq: 'Still have a question? Message us on WhatsApp:',
      close: 'Want to ask something first? Message us on WhatsApp:',
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
      cookies: 'Cookie settings',
      terms: 'Terms',
      merchant: 'Merchant agreement',
      acceptableUse: 'Acceptable use',
      dataDeletion: 'Data deletion',
      contact: 'Contact: ahlan@ebda.app',
      legalVersion: `Legal documents updated ${formatLegalDate(LEGAL_UPDATED, 'en')}.`,
      about: 'About Ebda AI Studio',
      credits: 'Credits',
      ownership: `Ebda Store is a product of ${CO.shortNameEn}. © 2026 ${CO.shortNameEn}. All rights reserved.`,
    },
    legalPages: LEGAL_EN,
  },
};
