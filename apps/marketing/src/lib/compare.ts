import type { CompareSlug, Locale } from './site';

/**
 * /compare/salla, /compare/zid, /compare/shopify. Balanced on purpose: assistants quote pages that
 * say where the other product is stronger. Ebda cells are proven by code (see capabilities.ts and
 * .superpowers/marketing-report.md); competitor cells are general, publicly known facts, dated
 * COMPARE_AS_OF, with no invented numbers. Where we are unsure what a competitor offers today the cell
 * says to check their site instead of guessing.
 */
export const COMPARE_AS_OF = 'October 2026';
export const COMPARE_AS_OF_AR = 'أكتوبر 2026';

type Pair = Record<Locale, string>;

/** 'ebda' = Ebda Store is stronger for an Egyptian seller, 'them' = the other platform is stronger, 'even' = comparable or compare yourself. */
export type Verdict = 'ebda' | 'them' | 'even';

export interface RowDef {
  id: string;
  label: Pair;
  /** What Ebda Store has (the same on all three pages). */
  ebda: Pair;
}

/** Rows where Ebda Store is stronger or comparable. */
export const STRENGTH_ROWS: readonly RowDef[] = [
  {
    id: 'market',
    label: { ar: 'السوق الأساسي', en: 'Home market' },
    ebda: {
      ar: 'مصر أولًا: جنيه مصري، وإنستا باي، وشركات شحن مصرية.',
      en: 'Egypt first: Egyptian pounds, InstaPay and Egyptian carriers.',
    },
  },
  {
    id: 'currency',
    label: { ar: 'عملة الاشتراك', en: 'Subscription currency' },
    ebda: {
      ar: 'بالجنيه: 1,490 و3,490 و9,990 ج.م في الشهر.',
      en: 'In pounds: EGP 1,490, 3,490 and 9,990 a month.',
    },
  },
  {
    id: 'commission',
    label: { ar: 'عمولة على الطلبات', en: 'Commission on orders' },
    ebda: {
      ar: '0% على كل الطلبات في كل الباقات. رسوم بوابة الدفع منفصلة.',
      en: '0% on every order on every plan. Payment gateway fees are separate.',
    },
  },
  {
    id: 'arabic',
    label: { ar: 'العربي', en: 'Arabic' },
    ebda: {
      ar: 'المتجر ولوحة التحكم بالعربي من الأساس، والنصوص بالمصري.',
      en: 'Store and dashboard are Arabic-first, with Egyptian Arabic copy.',
    },
  },
  {
    id: 'search',
    label: { ar: 'بحث بالمصري والفرانكو', en: 'Egyptian and Franco search' },
    ebda: {
      ar: 'بحث بيوحّد أشكال الحروف العربية، والذكاء الاصطناعي بيضيف كلمات بحث بالعامية والفرانكو.',
      en: 'Search unifies Arabic letter variants, and AI adds Egyptian-dialect and Franco search words.',
    },
  },
  {
    id: 'ai',
    label: { ar: 'الذكاء الاصطناعي', en: 'AI tools' },
    ebda: {
      ar: 'وصف وترجمة وSEO وكلمات بحث، مشمولة في الباقات المدفوعة.',
      en: 'Descriptions, translation, SEO and search words, included in the paid plans.',
    },
  },
  {
    id: 'payments',
    label: { ar: 'الدفع والشحن في مصر', en: 'Payments and shipping in Egypt' },
    ebda: {
      ar: 'الدفع عند الاستلام، وإنستا باي، وPaymob وKashier وFawryPay، وشحن مع بوسطة وShipBlu ومايلرز وأرامكس.',
      en: 'Cash on delivery, InstaPay, Paymob, Kashier, FawryPay, and shipping with Bosta, ShipBlu, Mylerz and Aramex.',
    },
  },
  {
    id: 'builder',
    label: { ar: 'القوالب والتصميم', en: 'Templates and design' },
    ebda: {
      ar: 'خمس قوالب، في كل قالب ثلاث أشكال، ومحرر صفحات.',
      en: 'Five templates with three looks each, and a page builder.',
    },
  },
  {
    id: 'growth',
    label: { ar: 'سلات متروكة ونقاط ولاء', en: 'Cart recovery and loyalty' },
    ebda: {
      ar: 'استرجاع السلات المتروكة ونقاط الولاء من باقة النمو.',
      en: 'Abandoned-cart recovery and loyalty points from the Growth plan.',
    },
  },
];

/** Rows where Ebda Store is not there yet. */
export const GAP_ROWS: readonly RowDef[] = [
  {
    id: 'apps',
    label: { ar: 'متجر تطبيقات', en: 'App marketplace' },
    ebda: { ar: 'مفيش متجر تطبيقات.', en: 'There is no app marketplace.' },
  },
  {
    id: 'code',
    label: { ar: 'تخصيص بالأكواد', en: 'Custom code' },
    ebda: {
      ar: 'التعديل من محرر الصفحات من غير أكواد، ومفيش محرر أكواد مخصص.',
      en: 'You edit in the page builder without code, and there is no custom code editor.',
    },
  },
  {
    id: 'b2b',
    label: { ar: 'أسعار الجملة (B2B)', en: 'Wholesale (B2B) pricing' },
    ebda: {
      ar: 'مفيش قوائم أسعار جملة. مجموعات العملاء بتستهدف الكوبونات والعروض بس.',
      en: 'There are no wholesale price lists. Customer groups only target coupons and promotions.',
    },
  },
  {
    id: 'pos',
    label: { ar: 'نقطة بيع (POS)', en: 'Point of sale (POS)' },
    ebda: { ar: 'مفيش نقطة بيع في الفروع.', en: 'There is no in-store point of sale.' },
  },
  {
    id: 'multicur',
    label: { ar: 'عملات متعددة', en: 'Multiple currencies' },
    ebda: { ar: 'المتجر بالجنيه المصري بس.', en: 'The store sells in Egyptian pounds only.' },
  },
  {
    id: 'email',
    label: { ar: 'حملات الإيميل التسويقية', en: 'Marketing email campaigns' },
    ebda: {
      ar: 'إيميلات الطلبات شغالة. حملات الإيميل التسويقية متبنية بس لسه مش في الباقات، وبنفعّلها لكل متجر على حدة.',
      en: 'Order emails work. Marketing email campaigns are built but not in the plans yet; we switch them on store by store.',
    },
  },
  {
    id: 'ecosystem',
    label: { ar: 'حجم المنصة والمجتمع', en: 'Size of platform and community' },
    ebda: {
      ar: 'منصة جديدة، فعدد التكاملات والمجتمع أصغر.',
      en: 'A newer platform, so fewer integrations and a smaller community.',
    },
  },
];

interface Them {
  v: Verdict;
  text: Pair;
}

const same = (en: string, ar: string): Pair => ({ en, ar });

const GULF = {
  market: same('Saudi Arabia and the Gulf first.', 'السعودية والخليج أولًا.'),
  currency: same('Priced in Saudi riyals.', 'الاشتراك بالريال السعودي.'),
  commission: same(
    'Check the current plan terms on their site. Payment gateway fees apply on any platform.',
    'راجع شروط الباقات الحالية على موقعهم. ورسوم بوابة الدفع بتتحسب على أي منصة.'
  ),
  arabic: same(
    'Arabic-first, built for Arabic-speaking merchants.',
    'عربية من الأساس، ومبنية للتجار العرب.'
  ),
  search: same(
    'Compare the current search features on their site.',
    'قارن مميزات البحث الحالية على موقعهم.'
  ),
  ai: same(
    'Has AI features. Compare the current scope and which plan includes them.',
    'فيها أدوات ذكاء اصطناعي. قارن النطاق الحالي وأي باقة بتشملها.'
  ),
  payments: same(
    'Strong Gulf coverage. Check which Egyptian gateways and carriers are available.',
    'تغطية قوية للخليج. اتأكد من بوابات الدفع وشركات الشحن المصرية المتاحة.'
  ),
  builder: same('A theme store and a theme editor.', 'متجر قوالب ومحرر قوالب.'),
  growth: same('Available, built in or through apps.', 'متاحة، جاهزة أو من خلال تطبيقات.'),
  apps: same(
    'An app store with many third-party apps.',
    'متجر تطبيقات فيه تطبيقات كتير من أطراف تانية.'
  ),
  code: same('Developer tools for custom themes.', 'أدوات للمطورين لتخصيص القوالب.'),
  b2b: same('Available through apps or higher plans.', 'متاحة من خلال تطبيقات أو باقات أعلى.'),
  pos: same('A point-of-sale offering for physical shops.', 'عندهم حل نقطة بيع للمحلات.'),
  multicur: same('Supports selling in more than one currency.', 'بيدعموا البيع بأكتر من عملة.'),
  email: same(
    'Email marketing through built-in tools or apps.',
    'تسويق بالإيميل من أدوات جاهزة أو تطبيقات.'
  ),
  ecosystem: same(
    'An established platform with a large merchant base and partner ecosystem.',
    'منصة راسخة بقاعدة تجار كبيرة وشركاء كتير.'
  ),
} satisfies Record<string, Pair>;

const verdictOf: Record<string, Verdict> = {
  market: 'ebda',
  currency: 'ebda',
  commission: 'even',
  arabic: 'even',
  search: 'even',
  ai: 'even',
  payments: 'even',
  builder: 'even',
  growth: 'even',
  apps: 'them',
  code: 'them',
  b2b: 'them',
  pos: 'them',
  multicur: 'them',
  email: 'them',
  ecosystem: 'them',
};

const them = (cells: Record<string, Pair>, over: Partial<Record<string, Verdict>> = {}) =>
  Object.fromEntries(
    Object.entries(cells).map(([id, text]) => [
      id,
      { v: over[id] ?? verdictOf[id], text } satisfies Them,
    ])
  ) as Record<string, Them>;

export interface CompareCopy {
  name: string;
  title: string;
  desc: string;
  h1: string;
  intro: string;
  chooseThemH: string;
  chooseThem: string[];
  chooseEbdaH: string;
  chooseEbda: string[];
  /** Link text on /features and the home page. */
  linkText: string;
}

export type CompareDef = Record<Locale, CompareCopy> & { cells: Record<string, Them> };

const ebdaChoiceAr = [
  'بتبيع في مصر وعايز تدفع الاشتراك بالجنيه.',
  'عايز إنستا باي والدفع عند الاستلام وشركات الشحن المصرية جاهزين.',
  'عايز بحث بيفهم المصري والفرانكو، وذكاء اصطناعي مشمول في السعر.',
  'عايز صفر عمولة على الطلبات.',
];
const ebdaChoiceEn = [
  'You sell in Egypt and want to pay the subscription in pounds.',
  'You want InstaPay, cash on delivery and Egyptian carriers ready to go.',
  'You want search that understands Egyptian Arabic and Franco, and AI included in the price.',
  'You want 0% commission on orders.',
];

const gulfCopy = (nameEn: string, nameAr: string): Record<Locale, CompareCopy> => ({
  ar: {
    name: nameAr,
    title: `ابدأ ستور مقابل ${nameAr}`,
    desc: `مقارنة صريحة بين ابدأ ستور و${nameAr} لبائع في مصر: فين ابدأ ستور أقوى، وفين ${nameAr} أقوى، وإيه اللي لسه مش موجود. بتاريخ أكتوبر 2026.`,
    h1: `ابدأ ستور مقابل ${nameAr}`,
    intro: `ابدأ ستور و${nameAr} الاتنين بيخلّوك تفتح متجر أونلاين بالعربي. الفرق إن ابدأ ستور مبني لمصر، و${nameAr} مبني للسعودية والخليج. الجدول ده بيقولك فين كل واحد أقوى، وإحنا صريحين في اللي لسه مش عندنا.`,
    chooseThemH: `اختار ${nameAr} لو`,
    chooseThem: [
      'بتبيع في السعودية أو الخليج.',
      'محتاج متجر تطبيقات كبير وتكاملات كتير.',
      'محتاج نقطة بيع لمحل، أو أسعار جملة، أو بيع بأكتر من عملة.',
    ],
    chooseEbdaH: 'اختار ابدأ ستور لو',
    chooseEbda: ebdaChoiceAr,
    linkText: `ابدأ ستور مقابل ${nameAr}`,
  },
  en: {
    name: nameEn,
    title: `Ebda Store vs ${nameEn}`,
    desc: `An honest comparison of Ebda Store and ${nameEn} for a seller in Egypt: where Ebda Store is stronger, where ${nameEn} is stronger, and what is not there yet. As of October 2026.`,
    h1: `Ebda Store vs ${nameEn}`,
    intro: `Both Ebda Store and ${nameEn} let you open an online store in Arabic. The difference is that Ebda Store is built for Egypt, while ${nameEn} is built for Saudi Arabia and the Gulf. This page says where each is stronger, including what Ebda Store does not have yet.`,
    chooseThemH: `Choose ${nameEn} if`,
    chooseThem: [
      'You sell in Saudi Arabia or the Gulf.',
      'You need a large app store and many integrations.',
      'You need a point of sale for a shop, wholesale pricing, or selling in more than one currency.',
    ],
    chooseEbdaH: 'Choose Ebda Store if',
    chooseEbda: ebdaChoiceEn,
    linkText: `Ebda Store vs ${nameEn}`,
  },
});

export const COMPARE: Record<CompareSlug, CompareDef> = (() => {
  const salla = gulfCopy('Salla', 'سلة');
  const zid = gulfCopy('Zid', 'زد');
  const shopify: Record<Locale, CompareCopy> = {
    ar: {
      name: 'شوبيفاي',
      title: 'ابدأ ستور مقابل شوبيفاي',
      desc: 'مقارنة صريحة بين ابدأ ستور وشوبيفاي لبائع في مصر: فين ابدأ ستور أقوى، وفين شوبيفاي أقوى، وإيه اللي لسه مش موجود. بتاريخ أكتوبر 2026.',
      h1: 'ابدأ ستور مقابل شوبيفاي',
      intro:
        'شوبيفاي منصة عالمية كبيرة بتخدم تجار في دول كتير، وابدأ ستور مبني لمصر بس. الجدول ده بيقولك فين كل واحد أقوى، وإحنا صريحين في اللي لسه مش عندنا.',
      chooseThemH: 'اختار شوبيفاي لو',
      chooseThem: [
        'بتبيع لعملاء في أكتر من دولة وبأكتر من عملة.',
        'محتاج متجر تطبيقات ضخم، أو نقطة بيع، أو أسعار جملة.',
        'عندك مطوّر وعايز تخصيص عميق بالكود.',
      ],
      chooseEbdaH: 'اختار ابدأ ستور لو',
      chooseEbda: ebdaChoiceAr,
      linkText: 'ابدأ ستور مقابل شوبيفاي',
    },
    en: {
      name: 'Shopify',
      title: 'Ebda Store vs Shopify',
      desc: 'An honest comparison of Ebda Store and Shopify for a seller in Egypt: where Ebda Store is stronger, where Shopify is stronger, and what is not there yet. As of October 2026.',
      h1: 'Ebda Store vs Shopify',
      intro:
        'Shopify is a large global platform serving merchants in many countries, while Ebda Store is built for Egypt only. This page says where each is stronger, including what Ebda Store does not have yet.',
      chooseThemH: 'Choose Shopify if',
      chooseThem: [
        'You sell to customers in more than one country and in more than one currency.',
        'You need a very large app store, a point of sale or wholesale pricing.',
        'You have a developer and want deep customisation in code.',
      ],
      chooseEbdaH: 'Choose Ebda Store if',
      chooseEbda: ebdaChoiceEn,
      linkText: 'Ebda Store vs Shopify',
    },
  };
  const shopifyCells = them(
    {
      market: same('Global, with merchants in many countries.', 'عالمية، وتجارها في دول كتير.'),
      currency: same('Priced in US dollars.', 'الاشتراك بالدولار الأمريكي.'),
      commission: same(
        'A transaction fee applies on orders paid through third-party gateways unless you use Shopify Payments. Check whether it is available for Egypt.',
        'فيه رسوم معاملة على الطلبات اللي بتتدفع عن طريق بوابات خارجية، إلا لو استخدمت Shopify Payments. اتأكد إذا كانت متاحة في مصر.'
      ),
      arabic: same(
        'Arabic and right-to-left are supported, mainly through themes and apps.',
        'العربي والكتابة من اليمين لليسار مدعومين، غالبًا من خلال القوالب والتطبيقات.'
      ),
      search: same(
        'Compare the current search features and apps.',
        'قارن مميزات البحث والتطبيقات الحالية.'
      ),
      ai: same(
        'Has AI features. Compare the current scope and which plan includes them.',
        'فيها أدوات ذكاء اصطناعي. قارن النطاق الحالي وأي باقة بتشملها.'
      ),
      payments: same(
        'Egyptian gateways and carriers depend on apps and integrations. Check what is available.',
        'بوابات الدفع وشركات الشحن المصرية بتعتمد على تطبيقات وتكاملات. اتأكد من المتاح.'
      ),
      builder: same('A very large theme store and a theme editor.', 'متجر قوالب ضخم ومحرر قوالب.'),
      growth: same('Available, built in or through apps.', 'متاحة، جاهزة أو من خلال تطبيقات.'),
      apps: same('A very large app store.', 'متجر تطبيقات ضخم.'),
      code: same('A theme code editor and developer tools.', 'محرر أكواد للقوالب وأدوات للمطورين.'),
      b2b: same('B2B features on higher plans.', 'ميزات B2B في الباقات الأعلى.'),
      pos: same('Shopify POS for physical shops.', 'Shopify POS للمحلات.'),
      multicur: same('Selling in multiple currencies and countries.', 'بيع بعملات ودول متعددة.'),
      email: same(
        'Email marketing through built-in tools or apps.',
        'تسويق بالإيميل من أدوات جاهزة أو تطبيقات.'
      ),
      ecosystem: same(
        'An established platform with a very large merchant base and partner ecosystem.',
        'منصة راسخة بقاعدة تجار ضخمة وشركاء كتير.'
      ),
    },
    { commission: 'ebda', arabic: 'even' }
  );
  const gulfCells = them(GULF);
  return {
    salla: { ...salla, cells: gulfCells },
    zid: { ...zid, cells: gulfCells },
    shopify: { ...shopify, cells: shopifyCells },
  };
})();

export const COMPARE_PAGE: Record<
  Locale,
  {
    strongH: string;
    gapH: string;
    colWhat: string;
    colEbda: string;
    asOf: string;
    verify: string;
    cta: string;
    allFeatures: string;
    verdict: Record<Verdict, string>;
  }
> = {
  ar: {
    strongH: 'فين ابدأ ستور أقوى أو مساوي',
    gapH: 'اللي لسه مش موجود في ابدأ ستور',
    colWhat: 'الموضوع',
    colEbda: 'ابدأ ستور',
    asOf: `المقارنة بتاريخ ${COMPARE_AS_OF_AR}.`,
    verify:
      'معلومات المنافسين مأخوذة من اللي منشور للعامة وبتتغير. راجع موقعهم الرسمي قبل ما تقرر.',
    cta: 'ابدأ دلوقتي',
    allFeatures: 'شوف كل مميزات ابدأ ستور',
    verdict: {
      ebda: 'ابدأ ستور أقوى',
      them: 'التاني أقوى',
      even: 'متقاربين أو قارن بنفسك',
    },
  },
  en: {
    strongH: 'Where Ebda Store is stronger or comparable',
    gapH: 'What Ebda Store does not have yet',
    colWhat: 'Topic',
    colEbda: 'Ebda Store',
    asOf: `Comparison as of ${COMPARE_AS_OF}.`,
    verify:
      'Competitor information comes from what is publicly published and changes over time. Check their official site before you decide.',
    cta: 'Start now',
    allFeatures: 'See all Ebda Store features',
    verdict: {
      ebda: 'Ebda Store stronger',
      them: 'Stronger there',
      even: 'Comparable, or compare yourself',
    },
  },
};
