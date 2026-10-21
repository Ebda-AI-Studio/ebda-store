import { isLive, type CapabilityId } from './capability-registry';
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
  /** Default table when nothing in the registry moves it. */
  group: 'strength' | 'gap';
  /** The registry capability this row is about: while it is `coming` the row sits in the "not yet" table. */
  needs?: CapabilityId;
  /** What Ebda Store has (the same on all three pages). */
  ebda: Pair;
  /** Shown instead of `ebda` while `needs` is coming. */
  soon?: Pair;
  /** Appended to `ebda` once `needs` is live (an addition to a row that is live without it). */
  plus?: { needs: CapabilityId; text: Pair };
}

const ROWS: readonly RowDef[] = [
  {
    id: 'market',
    group: 'strength',
    label: { ar: 'السوق الأساسي', en: 'Home market' },
    ebda: {
      ar: 'مصر أولًا: جنيه مصري، وإنستا باي، وشركات شحن مصرية.',
      en: 'Egypt first: Egyptian pounds, InstaPay and Egyptian carriers.',
    },
  },
  {
    id: 'currency',
    group: 'strength',
    label: { ar: 'عملة الاشتراك', en: 'Subscription currency' },
    ebda: {
      ar: 'بالجنيه: 1,490 و3,490 و9,990 ج.م في الشهر.',
      en: 'In pounds: EGP 1,490, 3,490 and 9,990 a month.',
    },
  },
  {
    id: 'commission',
    group: 'strength',
    label: { ar: 'عمولة على الطلبات', en: 'Commission on orders' },
    ebda: {
      ar: '0% على كل الطلبات في كل الباقات. رسوم بوابة الدفع منفصلة.',
      en: '0% on every order on every plan. Payment gateway fees are separate.',
    },
  },
  {
    id: 'arabic',
    group: 'strength',
    label: { ar: 'العربي', en: 'Arabic' },
    ebda: {
      ar: 'المتجر ولوحة التحكم بالعربي من الأساس، والنصوص بالمصري.',
      en: 'Store and dashboard are Arabic-first, with Egyptian Arabic copy.',
    },
  },
  {
    id: 'search',
    group: 'strength',
    label: { ar: 'بحث بالمصري والفرانكو', en: 'Egyptian and Franco search' },
    ebda: {
      ar: 'بحث بيفهم المصري والفرانكو والإنجليزي وأشكال الحروف، وكل منتج بياخد كلمات بحث بالذكاء الاصطناعي تقدر تعدّلها.',
      en: 'Search understands Egyptian Arabic, Franco, English and letter variants, and every product gets AI search words you can edit.',
    },
  },
  {
    id: 'meaning',
    group: 'gap',
    needs: 'meaning',
    label: { ar: 'بحث بالمعنى', en: 'Search by meaning' },
    ebda: {
      ar: 'العميل يكتب اللي في دماغه والبحث يفهم قصده.',
      en: 'Shoppers type what they have in mind and search understands what they mean.',
    },
    soon: {
      ar: 'قريبًا: بنطرحه تدريجيًا، ومش بيتفعّل على متجرك غير لما نتأكد إن نتايجه ممتازة على منتجات حقيقية.',
      en: 'Coming soon: rolling out gradually, and only switched on for your store once its results pass our quality check on a real catalogue.',
    },
  },
  {
    id: 'insights',
    group: 'strength',
    label: { ar: 'إحصائيات البحث', en: 'Search insights' },
    ebda: {
      ar: 'شوف عملاءك بحثوا عن إيه، وإيه اللي مالقوش له نتيجة.',
      en: 'See what shoppers searched for, and what they searched for and found nothing.',
    },
  },
  {
    id: 'ai',
    group: 'strength',
    label: { ar: 'الذكاء الاصطناعي', en: 'AI tools' },
    ebda: {
      ar: 'وصف وترجمة وSEO وكلمات بحث، وإيصالات المصروفات واقتراحات إعادة الطلب وشرح الأرقام، مشمولة في الباقات المدفوعة.',
      en: 'Descriptions, translation, SEO and search words, plus receipt-to-expense drafts, reorder suggestions and plain-language explanations of your numbers, included in the paid plans.',
    },
  },
  {
    id: 'payments',
    group: 'strength',
    label: { ar: 'الدفع والشحن في مصر', en: 'Payments and shipping in Egypt' },
    ebda: {
      ar: 'الدفع عند الاستلام، وإنستا باي، وPaymob وKashier وFawryPay، وشحن مع بوسطة وShipBlu ومايلرز وأرامكس.',
      en: 'Cash on delivery, InstaPay, Paymob, Kashier, FawryPay, and shipping with Bosta, ShipBlu, Mylerz and Aramex.',
    },
  },
  {
    id: 'builder',
    group: 'strength',
    label: { ar: 'القوالب والتصميم', en: 'Templates and design' },
    ebda: {
      ar: 'خمس قوالب، في كل قالب ثلاث أشكال، ومحرر صفحات.',
      en: 'Five templates with three looks each, and a page builder.',
    },
  },
  {
    id: 'growth',
    group: 'strength',
    label: { ar: 'سلات متروكة ونقاط ولاء', en: 'Cart recovery and loyalty' },
    ebda: {
      ar: 'استرجاع السلات المتروكة بإشعار أو SMS، ونقاط الولاء، من باقة النمو.',
      en: 'Abandoned-cart recovery by notification or SMS, and loyalty points, from the Growth plan.',
    },
    plus: {
      needs: 'cartemail',
      text: {
        ar: ' وكمان بالإيميل لو العميل وافق وهو بيدفع، حتى كزائر.',
        en: ' Plus reminder emails when the shopper opted in at checkout, guests included.',
      },
    },
  },
  {
    id: 'integrations',
    group: 'strength',
    needs: 'webhooks',
    label: { ar: 'ربط أدوات تانية (Webhooks)', en: 'Connecting other tools (webhooks)' },
    ebda: {
      ar: 'المتجر بيبعت إشعار للأداة اللي تحددها لما يحصل حاجة زي طلب جديد، في باقتي النمو والأعمال.',
      en: 'The store notifies the tool you choose when something happens, such as a new order, on Growth and Business.',
    },
    soon: {
      ar: 'قريبًا في باقتي النمو والأعمال: المتجر هيبعت إشعار للأداة اللي تحددها لما يحصل حاجة زي طلب جديد.',
      en: 'Coming soon on Growth and Business: the store will notify the tool you choose when something happens, such as a new order.',
    },
  },
  {
    id: 'apps',
    group: 'gap',
    label: { ar: 'متجر تطبيقات', en: 'App marketplace' },
    ebda: { ar: 'مفيش متجر تطبيقات.', en: 'There is no app marketplace.' },
  },
  {
    id: 'code',
    group: 'gap',
    label: { ar: 'تخصيص بالأكواد', en: 'Custom code' },
    ebda: {
      ar: 'التعديل من محرر الصفحات من غير أكواد، ومفيش محرر أكواد مخصص.',
      en: 'You edit in the page builder without code, and there is no custom code editor.',
    },
  },
  {
    id: 'b2b',
    group: 'gap',
    needs: 'b2b',
    label: { ar: 'أسعار الجملة (B2B)', en: 'Wholesale (B2B) pricing' },
    ebda: {
      ar: 'أسعار بتقل مع الكمية، ومجموعات عملاء، وحد أدنى للطلب، وموافقة على تجار الجملة، في باقة الأعمال.',
      en: 'Quantity price breaks, customer groups, minimum orders and wholesale-buyer approval, on the Business plan.',
    },
    soon: {
      ar: 'قريبًا في باقة الأعمال: أسعار بتقل مع الكمية، ومجموعات عملاء، وحد أدنى للطلب، وموافقة على تجار الجملة. لحد ما ينزل مفيش قوائم أسعار جملة.',
      en: 'Coming soon on the Business plan: quantity price breaks, customer groups, minimum orders and wholesale-buyer approval. Until it ships there are no wholesale price lists.',
    },
  },
  {
    id: 'pos',
    group: 'gap',
    label: { ar: 'نقطة بيع (POS)', en: 'Point of sale (POS)' },
    ebda: { ar: 'مفيش نقطة بيع في الفروع.', en: 'There is no in-store point of sale.' },
  },
  {
    id: 'multicur',
    group: 'gap',
    label: { ar: 'عملات متعددة', en: 'Multiple currencies' },
    ebda: { ar: 'المتجر بالجنيه المصري بس.', en: 'The store sells in Egyptian pounds only.' },
  },
  {
    id: 'email',
    group: 'gap',
    needs: 'campaigns',
    label: { ar: 'حملات الإيميل التسويقية', en: 'Marketing email campaigns' },
    ebda: {
      ar: 'اكتب رسالة بالعربي والإنجليزي وابعتها لمشتركين وافقوا، في باقتي النمو والأعمال. وإيميلات الطلبات شغالة في كل الباقات.',
      en: 'Write a message in Arabic and English and send it to subscribers who agreed, on Growth and Business. Order emails work on every plan.',
    },
    soon: {
      ar: 'قريبًا في باقتي النمو والأعمال. إيميلات الطلبات شغالة دلوقتي في كل الباقات.',
      en: 'Coming soon on Growth and Business. Order emails work today on every plan.',
    },
  },
  {
    id: 'ecosystem',
    group: 'gap',
    label: { ar: 'حجم المنصة والمجتمع', en: 'Size of platform and community' },
    ebda: {
      ar: 'منصة جديدة، فعدد التكاملات والمجتمع أصغر.',
      en: 'A newer platform, so fewer integrations and a smaller community.',
    },
  },
];

export interface ResolvedRow {
  id: string;
  label: Pair;
  ebda: Pair;
  /** True while the Ebda side of the row is a coming-soon item. */
  soon: boolean;
}

/** Rows resolved against the capability registry: coming items go to the "not yet" table with their coming text. */
export function compareRows(): { strength: ResolvedRow[]; gap: ResolvedRow[] } {
  const strength: ResolvedRow[] = [];
  const gap: ResolvedRow[] = [];
  for (const r of ROWS) {
    const coming = r.needs ? !isLive(r.needs) : false;
    const ebda: Pair =
      coming && r.soon
        ? r.soon
        : r.plus && isLive(r.plus.needs)
          ? { ar: r.ebda.ar + r.plus.text.ar, en: r.ebda.en + r.plus.text.en }
          : r.ebda;
    const resolved = { id: r.id, label: r.label, ebda, soon: coming };
    // a row about a capability follows the registry; other rows keep their default table
    const g = r.needs ? (coming ? 'gap' : 'strength') : r.group;
    (g === 'gap' ? gap : strength).push(resolved);
  }
  return { strength, gap };
}

export const ALL_ROW_IDS: readonly string[] = ROWS.map(r => r.id);

interface Them {
  v: Verdict;
  text: Pair;
}

const same = (en: string, ar: string): Pair => ({ en, ar });

/**
 * Per-vendor cells for Salla and Zid. Only facts we can stand behind (both started in Saudi Arabia, both are
 * Arabic-first); everything else says to check the vendor's own site, and its verdict is "even".
 */
const vendorCells = (nameEn: string, nameAr: string) =>
  ({
    market: same(`${nameEn} started in Saudi Arabia.`, `${nameAr} بدأت في السعودية.`),
    currency: same(
      `Check ${nameEn}'s site for current pricing and billing currency.`,
      `راجع موقع ${nameAr} للأسعار الحالية وعملة الاشتراك.`
    ),
    commission: same(
      `Check ${nameEn}'s current plan terms. Payment gateway fees apply on any platform.`,
      `راجع شروط باقات ${nameAr} الحالية. ورسوم بوابة الدفع بتتحسب على أي منصة.`
    ),
    arabic: same(`${nameEn} is Arabic-first.`, `${nameAr} عربية من الأساس.`),
    search: same(
      `Check ${nameEn}'s site for its current search features.`,
      `راجع موقع ${nameAr} لمميزات البحث الحالية.`
    ),
    ai: same(
      `Check ${nameEn}'s site for its AI features and which plan includes them.`,
      `راجع موقع ${nameAr} لأدوات الذكاء الاصطناعي وأي باقة بتشملها.`
    ),
    payments: same(
      `Check which Egyptian gateways and carriers ${nameEn} supports for your account.`,
      `اتأكد من بوابات الدفع وشركات الشحن المصرية اللي ${nameAr} بتدعمها لحسابك.`
    ),
    builder: same(
      `Check ${nameEn}'s site for its themes and editor.`,
      `راجع موقع ${nameAr} للقوالب والمحرر.`
    ),
    meaning: same(
      `Check ${nameEn}'s site for how its search handles meaning.`,
      `راجع موقع ${nameAr} لمعرفة هل البحث بيفهم المعنى.`
    ),
    insights: same(
      `Check ${nameEn}'s site for its search reports.`,
      `راجع موقع ${nameAr} لتقارير البحث.`
    ),
    integrations: same(
      `Check ${nameEn}'s site for webhooks and integrations.`,
      `راجع موقع ${nameAr} للتكاملات وإشعارات الأدوات.`
    ),
    growth: same(
      `Check ${nameEn}'s site for cart recovery and loyalty options.`,
      `راجع موقع ${nameAr} لخيارات السلات المتروكة والولاء.`
    ),
    apps: same(`Check ${nameEn}'s site for its app store.`, `راجع موقع ${nameAr} لمتجر التطبيقات.`),
    code: same(
      `Check ${nameEn}'s site for developer and theme customisation tools.`,
      `راجع موقع ${nameAr} لأدوات المطورين وتخصيص القوالب.`
    ),
    b2b: same(
      `Check ${nameEn}'s site for wholesale pricing.`,
      `راجع موقع ${nameAr} لأسعار الجملة.`
    ),
    pos: same(
      `Check ${nameEn}'s site for in-store selling options.`,
      `راجع موقع ${nameAr} لخيارات البيع من المحل.`
    ),
    multicur: same(
      `Check ${nameEn}'s site for multi-currency support.`,
      `راجع موقع ${nameAr} لدعم العملات المتعددة.`
    ),
    email: same(
      `Check ${nameEn}'s site for email marketing options.`,
      `راجع موقع ${nameAr} لخيارات التسويق بالإيميل.`
    ),
    ecosystem: same(
      `Check ${nameEn}'s site for its merchant base and partners.`,
      `راجع موقع ${nameAr} لعدد التجار والشركاء.`
    ),
  }) satisfies Record<string, Pair>;

const verdictOf: Record<string, Verdict> = {};

const them = (cells: Record<string, Pair>, over: Partial<Record<string, Verdict>> = {}) =>
  Object.fromEntries(
    Object.entries(cells).map(([id, text]) => [
      id,
      { v: over[id] ?? verdictOf[id] ?? 'even', text } satisfies Them,
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
    intro: `ابدأ ستور و${nameAr} الاتنين بيخلّوك تفتح متجر أونلاين بالعربي. الفرق إن ابدأ ستور مبني لمصر، و${nameAr} بدأت في السعودية. الجدول ده بيقولك فين كل واحد أقوى، وإحنا صريحين في اللي لسه مش عندنا.`,
    chooseThemH: `اختار ${nameAr} لو`,
    chooseThem: [
      `بتبيع في السعودية أو الخليج وخدمة ${nameAr} مناسبة لسوقك.`,
      `محتاج حاجة مش موجودة في ابدأ ستور لسه، زي متجر تطبيقات أو نقطة بيع أو بيع بأكتر من عملة، واتأكدت إنها متاحة عند ${nameAr}.`,
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
    intro: `Both Ebda Store and ${nameEn} let you open an online store in Arabic. The difference is that Ebda Store is built for Egypt, while ${nameEn} started in Saudi Arabia. This page says where each is stronger, including what Ebda Store does not have yet.`,
    chooseThemH: `Choose ${nameEn} if`,
    chooseThem: [
      `You sell in Saudi Arabia or the Gulf and ${nameEn} serves your market.`,
      `You need something Ebda Store lacks, such as an app store, a point of sale or multiple currencies, and you have confirmed ${nameEn} offers it.`,
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
      currency: same(
        "Check Shopify's site for the billing currency in Egypt.",
        'راجع موقع شوبيفاي لعملة الاشتراك في مصر.'
      ),
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
      meaning: same(
        "Check Shopify's site for how its search handles meaning.",
        'راجع موقع شوبيفاي لمعرفة هل البحث بيفهم المعنى.'
      ),
      insights: same(
        'Search reports are available; compare the detail.',
        'فيه تقارير بحث، قارن مستوى التفاصيل.'
      ),
      integrations: same(
        'Webhooks and a developer API are available, alongside the app store.',
        'فيه Webhooks وواجهة للمطورين مع متجر التطبيقات.'
      ),
      apps: same('A very large app store.', 'متجر تطبيقات ضخم.'),
      code: same('A theme code editor and developer tools.', 'محرر أكواد للقوالب وأدوات للمطورين.'),
      b2b: same(
        "Check Shopify's site for B2B features and which plans include them.",
        'راجع موقع شوبيفاي لميزات B2B وأي باقات بتشملها.'
      ),
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
    {
      market: 'ebda',
      commission: 'ebda',
      apps: 'them',
      code: 'them',
      pos: 'them',
      multicur: 'them',
      ecosystem: 'them',
    }
  );

  return {
    salla: { ...salla, cells: them(vendorCells('Salla', 'سلة')) },
    zid: { ...zid, cells: them(vendorCells('Zid', 'زد')) },
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
    gapH: 'اللي لسه مش موجود في ابدأ ستور، واللي جاي قريبًا',
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
    gapH: 'What Ebda Store does not have yet, and what is coming soon',
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
