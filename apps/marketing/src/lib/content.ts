import type { Locale } from './site';

export type Status = 'launch' | 'coming';

export interface FeatureCopy {
  eyebrow: string;
  title: string;
  lead: string;
  points: string[];
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
  hero: { h1: string; sub: string; cta: string; secondary: string; note: string };
  status: Record<Status, string>;
  create: {
    eyebrow: string;
    title: string;
    lead: string;
    cta: string;
    slugLabel: string;
    points: string[];
  };
  how: { eyebrow: string; title: string; lead: string; steps: { t: string; d: string }[] };
  builder: FeatureCopy;
  products: FeatureCopy;
  orders: FeatureCopy;
  payments: {
    eyebrow: string;
    title: string;
    lead: string;
    methods: { name: string; desc: string; status: Status }[];
    note: string;
  };
  whatsapp: {
    eyebrow: string;
    title: string;
    lead: string;
    free: string[];
    later: string;
    laterTitle: string;
  };
  analytics: FeatureCopy;
  pricing: { eyebrow: string; title: string; lead: string; note: string; cta: string };
  stories: {
    eyebrow: string;
    title: string;
    lead: string;
    cardTitle: string;
    cardBody: string;
    firstMerchantLabel: string;
  };
  faq: { eyebrow: string; title: string; items: { q: string; a: string }[] };
  login: { eyebrow: string; title: string; lead: string; login: string; start: string };
  footer: {
    product: string;
    legalNav: string;
    legal: string;
    privacy: string;
    terms: string;
    contact: string;
    by: string;
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
      title: 'ابدأ — ابدأ بيع أونلاين',
      description:
        'ابدأ منصة لبناء متجرك الإلكتروني في مصر: متجرك، أعمالك، وكل شيء في مكان واحد. دفع عند الاستلام وإنستا باي وواتساب، بالعربي والإنجليزي.',
    },
    skip: 'تخطَّ إلى المحتوى',
    nav: {
      label: 'التنقل الرئيسي',
      features: 'المزايا',
      solutions: 'الحلول',
      pricing: 'الأسعار',
      resources: 'المصادر',
      login: 'تسجيل الدخول',
      start: 'ابدأ البيع',
      menu: 'القائمة',
      switchTo: 'English',
      switchLabel: 'Switch to English',
    },
    hero: {
      h1: 'ابدأ بيع أونلاين.',
      sub: 'Your business, your store, everything in one place.',
      cta: 'ابدأ البيع',
      secondary: 'شاهد طريقة العمل',
      note: 'متجرك على <اسمك>.ebda.app مجانًا، وتقدر تربط دومينك الخاص.',
    },
    status: { launch: 'عند الإطلاق', coming: 'قريبًا' },
    create: {
      eyebrow: '1 · أنشئ متجرك',
      title: 'أنشئ متجرك بنفسك، من غير مكالمات ولا انتظار.',
      lead: 'سجّل، اختر اسم متجرك، وابدأ. ابدأ منصة ذاتية الخدمة: أنت من يبني ويدير، ونحن نوفر الأدوات.',
      cta: 'أنشئ متجرك',
      slugLabel: 'عنوان متجرك المجاني',
      points: ['حساب واحد بدل عدة تطبيقات', 'عنوان مجاني على ebda.app', 'ربط دومين خاص بك لاحقًا'],
    },
    how: {
      eyebrow: '2 · كيف تعمل ابدأ',
      title: 'من الفكرة إلى أول طلب في أربع خطوات.',
      lead: 'نفس الخطوات لكل تاجر، من الموبايل أو الكمبيوتر.',
      steps: [
        { t: 'سجّل', d: 'أنشئ حسابك واختر عنوان متجرك.' },
        { t: 'ابنِ', d: 'اختر الشكل، أضف شعارك وألوانك وصفحاتك.' },
        { t: 'أضف منتجاتك', d: 'أضف المنتجات يدويًا أو استوردها من ملف CSV.' },
        { t: 'استقبل الطلبات', d: 'العملاء يطلبون، وأنت تتابع كل شيء من لوحة واحدة.' },
      ],
    },
    builder: {
      eyebrow: '3 · منشئ المتجر',
      title: 'متجر بشكل احترافي، عربي من الأساس.',
      lead: 'صمّم متجرك وشاهد التغيير فورًا. كل شيء يعمل بالعربية من اليمين إلى اليسار، ومعه نسخة إنجليزية.',
      points: [
        'واجهة عربية RTL ونسخة إنجليزية للمتجر',
        'ألوان وشعار وصفحات من تحكمك',
        'يعمل بسلاسة على الموبايل أولًا',
        'عنوان <اسمك>.ebda.app مجانًا ودومين خاص عند رغبتك',
      ],
    },
    products: {
      eyebrow: '4 · المنتجات والمخزون',
      title: 'منتجاتك ومخزونك تحت السيطرة.',
      lead: 'أضف منتجاتك بصورها وأسعارها بالجنيه المصري، وتابع الكميات المتاحة أول بأول.',
      points: [
        'أسعار بالجنيه المصري',
        'خيارات للمنتج مثل المقاس واللون',
        'تتبع المخزون',
        'استيراد المنتجات من ملف CSV',
      ],
    },
    orders: {
      eyebrow: '5 · الطلبات',
      title: 'كل طلب في مكانه، من أول لحظة لحد التسليم.',
      lead: 'تابع حالة كل طلب، وراجع بيانات العميل وطريقة الدفع من لوحة واحدة تناسب شاشة الموبايل.',
      points: [
        'قائمة طلبات بحالات واضحة',
        'تأكيد تحويل إنستا باي بخطوة واحدة',
        'الدفع عند الاستلام',
        'ربط شركات الشحن قريبًا',
      ],
    },
    payments: {
      eyebrow: '6 · المدفوعات',
      title: 'طرق الدفع التي يستخدمها عملاؤك في مصر.',
      lead: 'الدفع عند الاستلام وإنستا باي جاهزان عند الإطلاق، وبوابات الدفع المصرية قادمة. نوضح لك بصدق ما هو متاح وما هو قادم.',
      methods: [
        {
          name: 'الدفع عند الاستلام',
          desc: 'الأكثر استخدامًا في مصر، مدعوم من اليوم الأول.',
          status: 'launch',
        },
        {
          name: 'إنستا باي',
          desc: 'العميل يحوّل، وأنت تؤكد التحويل بخطوة واحدة. لا يُشحن الطلب قبل تأكيدك.',
          status: 'launch',
        },
        { name: 'البطاقات والمحافظ', desc: 'عبر بوابات الدفع المصرية.', status: 'coming' },
        { name: 'التقسيط', desc: 'عبر مزوّدي الدفع بالتقسيط في مصر.', status: 'coming' },
      ],
      note: 'ما زلنا نضيف المزوّدين واحدًا تلو الآخر؛ لن نعلن عن طريقة دفع قبل أن تعمل فعلًا.',
    },
    whatsapp: {
      eyebrow: '7 · واتساب',
      title: 'اجعل عميلك على بُعد ضغطة من واتساب.',
      lead: 'زر محادثة واتساب مجاني يفتح محادثة مع رقمك ومعها نص جاهز مثل ملخص الطلب أو رابط المنتج.',
      free: [
        'روابط wa.me مجانية، بلا تكلفة على واتساب',
        'نص جاهز بتفاصيل الطلب أو المنتج',
        'يعمل على الموبايل والكمبيوتر',
        'يظهر في صفحة المنتج والسلة وصفحة الشكر',
      ],
      laterTitle: 'الرسائل الآلية: غير متاحة بعد',
      later:
        'إرسال رسائل تلقائية عبر واجهة واتساب للأعمال قيد التخطيط كإضافة مدفوعة لاحقًا. لا نعد بها الآن، والرابط المجاني لا يرسل شيئًا تلقائيًا؛ العميل هو من يضغط إرسال.',
    },
    analytics: {
      eyebrow: '8 · التحليلات',
      title: 'اعرف ماذا يبيع وماذا لا يبيع.',
      lead: 'لوحة بسيطة تُظهر مبيعاتك وطلباتك لتقرر بوضوح.',
      points: ['مبيعات وطلبات حسب الفترة', 'أكثر المنتجات مبيعًا', 'مستويات أعمق في الخطط الأعلى'],
    },
    pricing: {
      eyebrow: '9 · الأسعار',
      title: 'خطط لكل مرحلة من متجرك.',
      lead: 'جرّب باقة النمو لمدة ١٤ يومًا. لا توجد باقة مجانية أو عمولة على الطلبات.',
      note: 'وفر ٢٥٪ بالدفع السنوي. رسوم بوابة الدفع منفصلة. بعد تجاوز حد الطلبات، لديك مهلة ٧ أيام للترقية.',
      cta: 'ابدأ البيع',
    },
    stories: {
      eyebrow: '10 · قصص التجار',
      title: 'أول المتاجر على وشك الانطلاق.',
      lead: 'ابدأ منصة جديدة. نضيف هنا قصص التجار بكلامهم وبموافقتهم عند جهوزها.',
      cardTitle: 'أول متاجرنا تنطلق قريبًا',
      cardBody: 'سنشارك هنا تجربة التجار الأوائل بعد إطلاقهم وبإذنهم.',
      firstMerchantLabel: 'أول تاجر',
    },
    faq: {
      eyebrow: '11 · أسئلة شائعة',
      title: 'أسئلة نجيب عليها بصراحة.',
      items: [
        {
          q: 'ما طرق الدفع المتاحة؟',
          a: 'الدفع عند الاستلام وإنستا باي (مع خطوة تأكيد واحدة منك) عند الإطلاق. البطاقات والمحافظ عبر بوابات الدفع المصرية قادمة ولم تُفعّل بعد.',
        },
        {
          q: 'وشركات الشحن؟',
          a: 'ربط شركات الشحن مثل بوسطة وأرامكس وغيرها قادم. سنعلن عند عمل كل واحدة منها.',
        },
        {
          q: 'هل أحتاج دومين؟',
          a: 'لا. كل متجر يحصل على عنوان <اسمك>.ebda.app مجانًا، ويمكنك ربط دومين خاص بك فوق ذلك (قد يتطلب خطة مدفوعة، وسيُعلن).',
        },
        {
          q: 'هل المتجر بالعربية والإنجليزية؟',
          a: 'نعم. العربية من اليمين لليسار هي الأساس، وتتوفر نسخة إنجليزية.',
        },
        {
          q: 'هل واتساب مؤتمت؟',
          a: 'ليس بعد. المتاح هو زر محادثة مجاني عبر wa.me. الرسائل الآلية قادمة لاحقًا كإضافة.',
        },
        {
          q: 'كم السعر؟',
          a: 'الأساسية ١٬٤٩٠ ج.م شهريًا، والنمو ٣٬٤٩٠ ج.م، والأعمال ٩٬٩٩٠ ج.م، مع خصم ٢٥٪ على الدفع السنوي. لا توجد باقة مجانية ولا عمولة على الطلبات، وتبدأ بتجربة النمو ١٤ يومًا.',
        },
        {
          q: 'ماذا عن بياناتي؟',
          a: 'منتجاتك وطلباتك وعملاؤك بياناتك. تفاصيل المعالجة في صفحة الخصوصية (مسودة قيد المراجعة القانونية)، وأدوات التصدير على خارطة الطريق.',
        },
      ],
    },
    login: {
      eyebrow: '12 · تسجيل الدخول',
      title: 'عندك متجر بالفعل؟',
      lead: 'ادخل إلى لوحة التحكم، أو أنشئ متجرك الأول.',
      login: 'تسجيل الدخول',
      start: 'ابدأ البيع',
    },
    footer: {
      product: 'ابدأ — منتج من Whisky 11',
      legalNav: 'روابط قانونية',
      legal: 'الإشعار القانوني',
      privacy: 'الخصوصية',
      terms: 'الشروط',
      contact: 'تواصل: support@ebda.app',
      by: 'منتج من Whisky 11',
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
      title: 'Ebda — Start selling online',
      description:
        'Ebda is a self-serve store builder for Egypt: your business, your store, everything in one place. Cash on delivery, InstaPay and WhatsApp, in Arabic and English.',
    },
    skip: 'Skip to content',
    nav: {
      label: 'Main navigation',
      features: 'Features',
      solutions: 'Solutions',
      pricing: 'Pricing',
      resources: 'Resources',
      login: 'Log in',
      start: 'Start selling',
      menu: 'Menu',
      switchTo: 'العربية',
      switchLabel: 'التبديل إلى العربية',
    },
    hero: {
      h1: 'ابدأ بيع أونلاين.',
      sub: 'Your business, your store, everything in one place.',
      cta: 'Start selling',
      secondary: 'See how it works',
      note: 'Your store on <you>.ebda.app is free; bring your own domain when you want.',
    },
    status: { launch: 'At launch', coming: 'Coming' },
    create: {
      eyebrow: '1 · Create your store',
      title: 'Create your store yourself. No calls, no waiting.',
      lead: 'Sign up, pick your store name, and go. Ebda is self-serve: you build and run it, we provide the tools.',
      cta: 'Create your store',
      slugLabel: 'Your free store address',
      points: [
        'One account instead of many apps',
        'A free address on ebda.app',
        'Connect your own domain later',
      ],
    },
    how: {
      eyebrow: '2 · How Ebda works',
      title: 'From idea to first order in four steps.',
      lead: 'The same steps for every merchant, on phone or desktop.',
      steps: [
        { t: 'Sign up', d: 'Create your account and choose your store address.' },
        { t: 'Build', d: 'Pick a look, add your logo, colours and pages.' },
        { t: 'Add products', d: 'Add products by hand or import them from a CSV file.' },
        { t: 'Take orders', d: 'Customers order; you manage everything from one dashboard.' },
      ],
    },
    builder: {
      eyebrow: '3 · Store builder',
      title: 'A professional store, Arabic from the ground up.',
      lead: 'Design your store and see changes right away. Everything works right-to-left in Arabic, with an English version alongside.',
      points: [
        'Arabic RTL storefront plus an English version',
        'Colours, logo and pages under your control',
        'Mobile-first, so it feels right on phones',
        'A free <you>.ebda.app address, or your own domain',
      ],
    },
    products: {
      eyebrow: '4 · Products & inventory',
      title: 'Your products and stock, under control.',
      lead: 'Add products with photos and prices in Egyptian pounds, and keep an eye on what is in stock.',
      points: [
        'Prices in EGP',
        'Product options like size and colour',
        'Inventory tracking',
        'Import products from CSV',
      ],
    },
    orders: {
      eyebrow: '5 · Orders',
      title: 'Every order in one place, from checkout to delivery.',
      lead: 'Follow each order, and review customer details and payment method from one dashboard that fits a phone screen.',
      points: [
        'An order list with clear statuses',
        'Confirm an InstaPay transfer in one step',
        'Cash on delivery',
        'Shipping carrier integrations coming',
      ],
    },
    payments: {
      eyebrow: '6 · Payments',
      title: 'The payment methods your customers use in Egypt.',
      lead: 'Cash on delivery and InstaPay are ready at launch; Egyptian payment gateways are coming. We say plainly what is available and what is not.',
      methods: [
        {
          name: 'Cash on delivery',
          desc: 'The most used method in Egypt, supported from day one.',
          status: 'launch',
        },
        {
          name: 'InstaPay',
          desc: 'The customer transfers, you confirm it with one step. The order does not ship until you confirm.',
          status: 'launch',
        },
        { name: 'Cards and wallets', desc: 'Through Egyptian payment gateways.', status: 'coming' },
        {
          name: 'Instalments',
          desc: 'Through Egyptian buy-now-pay-later providers.',
          status: 'coming',
        },
      ],
      note: 'We add providers one at a time and will not announce a method before it actually works.',
    },
    whatsapp: {
      eyebrow: '7 · WhatsApp',
      title: 'Keep customers one tap from WhatsApp.',
      lead: 'A free WhatsApp click-to-chat button opens a chat with your number and a ready-made message, like an order summary or a product link.',
      free: [
        'Free wa.me links, no WhatsApp fees',
        'Prefilled text with order or product details',
        'Works on phone and desktop',
        'Shown on product, cart and thank-you pages',
      ],
      laterTitle: 'Automated messages: not available yet',
      later:
        'Automated messages through the WhatsApp Business Platform are planned as a paid add-on later. We are not promising them now, and a free link sends nothing by itself: the customer presses send.',
    },
    analytics: {
      eyebrow: '8 · Analytics',
      title: 'Know what sells and what does not.',
      lead: 'A simple dashboard of your sales and orders, so you can decide with clarity.',
      points: [
        'Sales and orders by period',
        'Best-selling products',
        'Deeper levels on higher plans',
      ],
    },
    pricing: {
      eyebrow: '9 · Pricing',
      title: 'Plans for every stage of your store.',
      lead: 'Try Growth for 14 days. No free plan and no platform commission on orders.',
      note: 'Save 25% with annual billing. Gateway fees are separate. After exceeding the order cap, you have 7 days to upgrade.',
      cta: 'Start selling',
    },
    stories: {
      eyebrow: '10 · Customer stories',
      title: 'The first stores are about to launch.',
      lead: 'Ebda is new. We will add merchant stories here, in their own words and with their permission, once they are ready.',
      cardTitle: 'Our first stores launch soon',
      cardBody:
        'We will share the first merchants’ experience here after they launch, with their consent.',
      firstMerchantLabel: 'First merchant',
    },
    faq: {
      eyebrow: '11 · FAQ',
      title: 'Questions we answer honestly.',
      items: [
        {
          q: 'Which payment methods are available?',
          a: 'Cash on delivery and InstaPay (with one confirmation step from you) at launch. Cards and wallets through Egyptian payment gateways are coming and are not live yet.',
        },
        {
          q: 'What about shipping carriers?',
          a: 'Integrations with carriers like Bosta, Aramex and others are coming. We will announce each one when it works.',
        },
        {
          q: 'Do I need a domain?',
          a: 'No. Every store gets a free <you>.ebda.app address, and you can attach your own custom domain on top (included in every paid plan).',
        },
        {
          q: 'Is the store in Arabic and English?',
          a: 'Yes. Right-to-left Arabic is the foundation, with an English version available.',
        },
        {
          q: 'Is WhatsApp automated?',
          a: 'Not yet. What is available is a free wa.me click-to-chat button. Automated messages are coming later as an add-on.',
        },
        {
          q: 'How much does it cost?',
          a: 'Basic is EGP 1,490 a month, Growth EGP 3,490 and Business EGP 9,990, with 25% off annual billing. There is no free plan and no commission on orders, and you start with a 14-day Growth trial.',
        },
        {
          q: 'What about my data?',
          a: 'Your products, orders and customers are yours. How data is handled is described on the Privacy page (a draft awaiting legal review); export tools are on the roadmap.',
        },
      ],
    },
    login: {
      eyebrow: '12 · Log in',
      title: 'Already have a store?',
      lead: 'Head to your dashboard, or create your first store.',
      login: 'Log in',
      start: 'Start selling',
    },
    footer: {
      product: 'Ebda — a Whisky 11 product',
      legalNav: 'Legal links',
      legal: 'Legal notice',
      privacy: 'Privacy',
      terms: 'Terms',
      contact: 'Contact: support@ebda.app',
      by: 'A Whisky 11 product',
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
