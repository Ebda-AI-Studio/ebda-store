import type { Locale } from './site';

export type Status = 'launch' | 'coming';

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
  status: Record<Status, string>;
  how: { title: string; steps: { t: string; d: string }[] };
  features: {
    title: string;
    items: { t: string; d: string }[];
    /** The illustrative phone storefront (an example store, not a real merchant). */
    phone: {
      label: string;
      caption: string;
      store: string;
      slug: string;
      products: { name: string; price: number; tone: string }[];
      cod: string;
      order: string;
    };
  };
  payments: {
    title: string;
    methods: { name: string; desc: string; status: Status }[];
    note: string;
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
    contact: string;
    /** Text before the linked company name, e.g. "A product of" → "A product of Whisky 11". */
    byPrefix: string;
    draftNote: string;
  };
  legalPages: {
    draftBadge: string;
    draftBody: string;
    back: string;
    legal: { title: string; sections: { h: string; p: string }[] };
    privacy: { title: string; sections: { h: string; p: string }[] };
    terms: { title: string; sections: { h: string; p: string }[] };
  };
}

export const COPY: Record<Locale, Copy> = {
  ar: {
    meta: {
      title: 'ابدأ | اعمل متجرك أونلاين في دقايق',
      description:
        'اعمل متجرك أونلاين في دقايق: لينك باسمك، دفع عند الاستلام وإنستا باي، وزرار واتساب. من غير عمولة على طلباتك، وجرّب 14 يوم.',
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
    status: { launch: 'متاح', coming: 'قريب' },
    how: {
      title: '3 خطوات وتستقبل أول طلب.',
      steps: [
        { t: 'سجّل', d: 'اختار اسم متجرك واللينك بتاعه.' },
        { t: 'نزّل منتجاتك', d: 'بالصور والأسعار، أو ارفعهم مرة واحدة من ملف CSV.' },
        { t: 'استقبل الطلبات', d: 'وتابعها كلها من موبايلك.' },
      ],
    },
    features: {
      title: 'متجر حقيقي، مش صفحة على السوشيال.',
      items: [
        { t: 'شكله على ذوقك', d: 'اللوجو والألوان والصفحات، بالعربي والإنجليزي.' },
        { t: 'مقاسات وألوان ومخزون', d: 'كل منتج بخياراته، والكميات بتتحدّث لوحدها.' },
        { t: 'الطلب يوصلك على واتساب', d: 'العميل يبعتلك تفاصيل الطلب جاهزة بضغطة.' },
        { t: 'أرقامك قدامك', d: 'اعرف إيه اللي بيتباع وإيه اللي واقف.' },
      ],
      phone: {
        label: 'مثال لمتجر على الموبايل',
        caption: 'مثال: متجر حلويات بيتي على ابدأ.',
        store: 'حلويات سلمى',
        slug: 'salma',
        products: [
          { name: 'كحك بالعجوة', price: 220, tone: 'a' },
          { name: 'غُريبة', price: 180, tone: 'b' },
          { name: 'بسكويت بالسمسم', price: 150, tone: 'c' },
          { name: 'بيتي فور', price: 240, tone: 'd' },
        ],
        cod: 'الدفع عند الاستلام',
        order: 'اطلب على واتساب',
      },
    },
    payments: {
      title: 'الدفع والشحن، زي ما عملاءك متعودين.',
      methods: [
        { name: 'الدفع عند الاستلام', desc: 'شغّال من أول يوم.', status: 'launch' },
        { name: 'إنستا باي', desc: 'العميل يحوّل، وإنت تأكد بضغطة.', status: 'launch' },
        { name: 'كروت ومحافظ', desc: 'من خلال بوابات دفع مصرية.', status: 'coming' },
        { name: 'بوسطة وأرامكس', desc: 'لحد ما يتربطوا، اشحن بطريقتك.', status: 'coming' },
      ],
      note: 'مش هنقولك على حاجة غير لما تشتغل فعلًا.',
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
          q: 'المتجر بالعربي؟',
          a: 'أيوه، عربي من الأساس، ومعاه نسخة إنجليزي.',
        },
        {
          q: 'واتساب بيبعت رسايل لوحده؟',
          a: 'لسه. دلوقتي فيه زرار واتساب، والعميل هو اللي بيدوس إرسال.',
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
      contact: 'تواصل: support@ebda.app',
      byPrefix: 'منتج من',
      draftNote: 'الصفحات القانونية مسودات قيد المراجعة.',
    },
    legalPages: {
      draftBadge: 'مسودة',
      draftBody:
        'هذه الصفحة مسودة مبدئية لحين مراجعتها من مستشار قانوني (في إطار القانون المصري). لا تُعد نصًا قانونيًا نهائيًا ولا يُعتمد عليها.',
      back: 'العودة إلى الرئيسية',
      legal: {
        title: 'الإشعار القانوني',
        sections: [
          {
            h: 'مقدّم الخدمة',
            p: 'ابدأ منتج تقدمه Whisky 11. [بيانات الشركة وبيانات التسجيل التجاري تُضاف بعد المراجعة القانونية.]',
          },
          { h: 'التواصل', p: 'للدعم: support@ebda.app. للإبلاغ عن ثغرة أمنية: security@ebda.app.' },
          {
            h: 'الاختصاص',
            p: '[يحدد المستشار القانوني القانون الواجب التطبيق والاختصاص القضائي بما يتوافق مع القوانين المصرية.]',
          },
        ],
      },
      privacy: {
        title: 'سياسة الخصوصية',
        sections: [
          {
            h: 'البيانات التي نعالجها',
            p: '[قائمة مبدئية: بيانات حساب التاجر، بيانات المتجر، وبيانات عملاء المتجر التي يعالجها التاجر عبر المنصة. يحدد المستشار التفاصيل.]',
          },
          {
            h: 'الأساس القانوني والحقوق',
            p: '[يُراجع في ضوء قانون حماية البيانات الشخصية المصري رقم ١٥١ لسنة ٢٠٢٠ ولائحته التنفيذية، ويشمل حقوق الاطلاع والتصحيح والمحو.]',
          },
          {
            h: 'الاحتفاظ والمعالجون',
            p: '[مدد الاحتفاظ ومزوّدو الخدمة المعالجون للبيانات تُستكمل قبل الإطلاق.]',
          },
          { h: 'التواصل', p: 'support@ebda.app' },
        ],
      },
      terms: {
        title: 'شروط الخدمة',
        sections: [
          {
            h: 'قبول الشروط',
            p: '[نص مبدئي: باستخدامك ابدأ فإنك توافق على هذه الشروط بعد اعتمادها.]',
          },
          {
            h: 'الحساب والمتجر',
            p: '[مسؤوليات التاجر عن محتوى متجره ومنتجاته والتزامه بالقوانين المصرية للتجارة الإلكترونية وحماية المستهلك.]',
          },
          {
            h: 'الخطط والرسوم',
            p: '[الأسعار معلنة في قسم الأسعار (أساسية ١٬٤٩٠ / نمو ٣٬٤٩٠ / أعمال ٩٬٩٩٠ ج.م شهريًا، دون عمولة على الطلبات). شروط الاسترداد تُضاف بعد اعتمادها.]',
          },
          { h: 'إنهاء الخدمة والمسؤولية', p: '[يحددها المستشار القانوني.]' },
        ],
      },
    },
  },
  en: {
    meta: {
      title: 'Ebda | Open your online store in minutes',
      description:
        'Open your online store in minutes: your own link, cash on delivery and InstaPay, and a WhatsApp button. No commission on orders. Try it 14 days.',
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
    status: { launch: 'Available', coming: 'Coming soon' },
    how: {
      title: 'Three steps to your first order.',
      steps: [
        { t: 'Sign up', d: 'Pick your store name and link.' },
        { t: 'Add products', d: 'With photos and prices, or upload a CSV in one go.' },
        { t: 'Take orders', d: 'And follow them all from your phone.' },
      ],
    },
    features: {
      title: 'A real store, not a social media page.',
      items: [
        { t: 'Your look', d: 'Logo, colours and pages, in Arabic and English.' },
        { t: 'Sizes, colours, stock', d: 'Every option per product; stock updates itself.' },
        { t: 'Orders on WhatsApp', d: 'Customers send you the order details in one tap.' },
        { t: 'Your numbers', d: 'See what sells and what doesn’t.' },
      ],
      phone: {
        label: 'Example store on a phone',
        caption: 'Example: a home bakery on Ebda.',
        store: 'Salma’s Sweets',
        slug: 'salma',
        products: [
          { name: 'Date kahk', price: 220, tone: 'a' },
          { name: 'Ghorayeba', price: 180, tone: 'b' },
          { name: 'Sesame biscuits', price: 150, tone: 'c' },
          { name: 'Petit four', price: 240, tone: 'd' },
        ],
        cod: 'Cash on delivery',
        order: 'Order on WhatsApp',
      },
    },
    payments: {
      title: 'Payment and shipping, the way your customers expect.',
      methods: [
        { name: 'Cash on delivery', desc: 'Works from day one.', status: 'launch' },
        {
          name: 'InstaPay',
          desc: 'The customer transfers; you confirm in one tap.',
          status: 'launch',
        },
        { name: 'Cards and wallets', desc: 'Through Egyptian payment gateways.', status: 'coming' },
        {
          name: 'Bosta and Aramex',
          desc: 'Until they’re connected, ship your way.',
          status: 'coming',
        },
      ],
      note: 'We won’t announce anything until it actually works.',
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
          q: 'Is the store in Arabic?',
          a: 'Yes, Arabic first, with an English version.',
        },
        {
          q: 'Does WhatsApp send messages by itself?',
          a: 'Not yet. Today there’s a WhatsApp button, and the customer presses send.',
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
      contact: 'Contact: support@ebda.app',
      byPrefix: 'A product of',
      draftNote: 'Legal pages are drafts pending review.',
    },
    legalPages: {
      draftBadge: 'DRAFT',
      draftBody:
        'This page is a placeholder draft pending review by legal counsel (Egyptian law context). It is not final legal text and must not be relied on.',
      back: 'Back to home',
      legal: {
        title: 'Legal notice',
        sections: [
          {
            h: 'Service provider',
            p: 'Ebda is a product of Whisky 11. [Company details and commercial registration information to be added after legal review.]',
          },
          { h: 'Contact', p: 'Support: support@ebda.app. Security reports: security@ebda.app.' },
          {
            h: 'Governing law',
            p: '[Governing law and jurisdiction to be set by counsel in line with Egyptian law.]',
          },
        ],
      },
      privacy: {
        title: 'Privacy policy',
        sections: [
          {
            h: 'Data we process',
            p: '[Initial list: merchant account data, store data, and store-customer data merchants process through the platform. Counsel to finalise.]',
          },
          {
            h: 'Legal basis and rights',
            p: '[To be reviewed against Egypt’s Personal Data Protection Law No. 151 of 2020 and its executive regulations, including rights of access, correction and erasure.]',
          },
          {
            h: 'Retention and processors',
            p: '[Retention periods and service providers acting as processors to be completed before launch.]',
          },
          { h: 'Contact', p: 'support@ebda.app' },
        ],
      },
      terms: {
        title: 'Terms of service',
        sections: [
          {
            h: 'Acceptance',
            p: '[Placeholder: by using Ebda you agree to these terms once adopted.]',
          },
          {
            h: 'Account and store',
            p: '[Merchant responsibility for store content and products, and compliance with Egyptian e-commerce and consumer-protection law.]',
          },
          {
            h: 'Plans and fees',
            p: '[Prices are published in the Pricing section (Basic EGP 1,490 / Growth 3,490 / Business 9,990 a month, no commission on orders). Refund terms to be added once adopted.]',
          },
          { h: 'Termination and liability', p: '[To be set by counsel.]' },
        ],
      },
    },
  },
};
