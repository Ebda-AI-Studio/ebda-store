import { BRAND } from '@force/shared/brand';
import { LEGAL_AR } from './legal-ar';
import { LEGAL_EN } from './legal-en';
import type { LegalPages } from './legal-types';
import type { Locale } from './site';

const CO = BRAND.company;
const PN = BRAND.product;

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

export interface RingCopy {
  label: string;
  hint: string;
  metalLabel: string;
  stoneLabel: string;
  metals: { gold: string; white: string; rose: string };
  stones: { diamond: string; emerald: string; ruby: string };
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
  };
  hero: {
    h1: string;
    /** Names the product (BRAND.product), then what it gives you. */
    sub: string;
    cta: string;
    /** Secondary link: jumps to #looks. */
    secondary: string;
    /** The one phone that cycles through the five templates' first look. */
    phone: {
      /** Accessible name of the cycling preview. */
      label: string;
      pause: string;
      play: string;
      /** aria-label of each vertical dot; `{name}` is the template name. */
      show: string;
      /** Visible caption mark: the preview is an illustration. */
      badge: string;
    };
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
  dahab: { title: string; lead: string; ring: RingCopy };
  /** The interactive template + look picker (5 templates x 3 looks, phone previews). */
  looks: LooksCopy;
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
      title: 'ابدأ استوديو للذكاء الاصطناعي — اعمل متجرك أونلاين في دقايق',
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
    },
    hero: {
      h1: 'ابدأ متجرك أونلاين في دقايق.',
      sub: `${PN.nameAr} بيديك لينك باسمك، ومنتجاتك، وطلباتك. كله من موبايلك.`,
      cta: 'ابدأ دلوقتي',
      secondary: 'شوف القوالب',
      phone: {
        label: 'معاينة بتتغيّر: أول شكل في كل قالب من القوالب الخمسة، بصور توضيحية',
        pause: 'وقّف التغيير',
        play: 'شغّل التغيير',
        show: 'اعرض قالب {name}',
        badge: 'صور توضيحية',
      },
    },
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
    story: {
      title: 'متجرك بيتبني قدامك.',
      steps: [
        { t: 'اختار اسم ولوجو.', d: 'سجّل بإيميل وباسورد، واختار اللينك بتاعك.' },
        { t: 'نزّل منتجاتك.', d: 'بالصور والأسعار والمقاسات، أو من ملف CSV.' },
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
            who: 'للستايليست ومحلات الفاست فاشن اللي بتبيع إطلالات مش قطع لوحدها.',
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
            who: 'لاستوديو فضة هاند ميد صنعته هي سبب إنك تدفع أكتر.',
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
      title: 'عن ابدأ استوديو للذكاء الاصطناعي',
      desc: 'ابدأ ستور منصة تقنية لبناء المتاجر الإلكترونية للتجار في مصر، من ابدأ استوديو للذكاء الاصطناعي.',
      brandLine: 'ابدأ استوديو للذكاء الاصطناعي — بابك لبدء مشروعك.',
      company: `ابدأ ستور منصة تقنية لبناء المتاجر الإلكترونية للتجار في مصر، مملوكة ل${CO.shortNameAr} وتديرها.`,
      storyH: 'حكاية ابدأ استوديو للذكاء الاصطناعي',
      contactH: 'تواصل معنا',
    },
    about: {
      title: 'حكاية ابدأ استوديو للذكاء الاصطناعي',
      paras: [
        'كل مشروع بيبدأ قبل ما يبقى مشروع، بيبدأ بجملة: «عندي فكرة».',
        'وبين الفكرة وأول عميل فيه أبواب كتير: موقع، وطلبات، وكلام مع العملاء، ومنتجات، ودفع، وتوصيل، وتكنولوجيا.',
        'ابدأ استوديو للذكاء الاصطناعي موجودة علشان تسهّل أول باب. علشان كده اللوجو باب، واللي جوّاه هو صاحب الفكرة، واقف على العتبة. مش محتاج يفهم في منصات التجارة الإلكترونية ولا الـ API ولا البنية التحتية ولا ربط واتساب. محتاج بس ياخد أول خطوة.',
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
      contact: 'تواصل: ahlan@ebda.app',
      legalVersion: 'الإصدار 1.0 من الوثائق القانونية · 2026-10-07.',
      about: 'عن ابدأ استوديو للذكاء الاصطناعي',
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
      looks: 'Templates',
      login: 'Log in',
      start: 'Start now',
      menu: 'Menu',
      switchTo: 'العربية',
      switchLabel: 'التبديل إلى العربية',
    },
    hero: {
      h1: 'Open your online store in minutes.',
      sub: `${PN.nameEn} gives you your own link, products and orders. All from your phone.`,
      cta: 'Start now',
      secondary: 'See the templates',
      phone: {
        label: 'A rotating preview: the first look of each of the five templates, illustrative',
        pause: 'Pause the preview',
        play: 'Play the preview',
        show: 'Show the {name} template',
        badge: 'Illustrative',
      },
    },
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
    story: {
      title: 'Watch your store come together.',
      steps: [
        { t: 'Pick a name and logo.', d: 'Sign up with email and password, then pick your link.' },
        { t: 'Add your products.', d: 'Photos, prices and sizes, or a CSV file.' },
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
      brandLine: 'Ebda AI Studio — Your doorway to business.',
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
      contact: 'Contact: ahlan@ebda.app',
      legalVersion: 'Legal documents version 1.0 · 2026-10-07.',
      about: 'About Ebda AI Studio',
      ownership: `Ebda Store is a product of ${CO.shortNameEn}. © 2026 ${CO.shortNameEn}. All rights reserved.`,
    },
    legalPages: LEGAL_EN,
  },
};
