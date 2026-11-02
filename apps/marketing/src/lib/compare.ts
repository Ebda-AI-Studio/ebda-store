import { isLive, type CapabilityId } from './capability-registry';
import type { CompareSlug, Locale } from './site';

/**
 * /compare/zid, /compare/shopify. Balanced on purpose: assistants quote pages that
 * say where the other product is stronger. Ebda cells are proven by code (see capabilities.ts and
 * .superpowers/marketing-report.md); competitor cells are general, publicly known facts, dated
 * COMPARE_AS_OF, with no invented numbers. Where we are unsure what a competitor offers today the cell
 * says to check their site instead of guessing.
 */
export const COMPARE_AS_OF = 'November 2026';
export const COMPARE_AS_OF_AR = 'نوفمبر 2026';
/** The day the sourced vendors' (Wuilt, YouCan, EasyOrders, ExpandCart) public pages were read. */
export const CHECKED_ON = '2 November 2026';
export const CHECKED_ON_AR = '2 نوفمبر 2026';

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
      ar: 'بحث بيفهم المصري والفرانكو والإنجليزي وأشكال الحروف، وكل منتج بياخد كلمات بحث بالذكاء الاصطناعي تقدر تعدّلها، وتشوف عملاءك بحثوا عن إيه ومالقوش إيه.',
      en: 'Search understands Egyptian Arabic, Franco, English and letter variants, and every product gets AI search words you can edit. You also see what shoppers searched for and did not find.',
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
      ar: 'استرجاع السلات المتروكة بإشعار من باقة النمو (والـSMS في باقة الأعمال بحساب SMS خاص بيك)، ونقاط الولاء.',
      en: 'Abandoned-cart recovery by notification from the Growth plan (SMS is on the Business plan, with your own SMS account), and loyalty points.',
    },
    plus: {
      needs: 'cart',
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
      ar: 'المتجر بيبعت إشعار للأداة اللي تحددها لما يحصل حاجة زي طلب جديد، في باقتَي النمو والأعمال.',
      en: 'The store notifies the tool you choose when something happens, such as a new order, on Growth and Business.',
    },
    soon: {
      ar: 'قريبًا في باقتَي النمو والأعمال: المتجر هيبعت إشعار للأداة اللي تحددها لما يحصل حاجة زي طلب جديد.',
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
      ar: 'اكتب رسالة بالعربي والإنجليزي وابعتها لمشتركين وافقوا، في باقتَي النمو والأعمال. وإيميلات الطلبات شغالة في كل الباقات.',
      en: 'Write a message in Arabic and English and send it to subscribers who agreed, on Growth and Business. Order emails work on every plan.',
    },
    soon: {
      ar: 'قريبًا في باقتَي النمو والأعمال. إيميلات الطلبات شغالة دلوقتي في كل الباقات.',
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
 * Per-vendor cells for Zid. Only facts we can stand behind (it started in Saudi Arabia, it is
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

/**
 * `sources` is set only for vendors whose public pricing/feature pages were read on CHECKED_ON: those pages may
 * carry dated figures and an "Ebda stronger / stronger there" verdict. Without it a page says "check their site".
 */
export interface CompareSource {
  name: string;
  href: string;
}
export type CompareDef = Record<Locale, CompareCopy> & {
  cells: Record<string, Them>;
  sources?: readonly CompareSource[];
};

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
    desc: `مقارنة صريحة بين ابدأ ستور و${nameAr} لبائع في مصر: فين ابدأ ستور أقوى، وفين ${nameAr} أقوى، وإيه اللي لسه مش موجود. بتاريخ نوفمبر 2026.`,
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
    desc: `Ebda Store vs ${nameEn} for a seller in Egypt: where each is stronger and what Ebda Store does not have yet. As of November 2026.`,
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
  const zid = gulfCopy('Zid', 'زد');
  const shopify: Record<Locale, CompareCopy> = {
    ar: {
      name: 'شوبيفاي',
      title: 'ابدأ ستور مقابل شوبيفاي',
      desc: 'مقارنة صريحة بين ابدأ ستور وشوبيفاي لبائع في مصر: فين ابدأ ستور أقوى، وفين شوبيفاي أقوى، وإيه اللي لسه مش موجود. بتاريخ نوفمبر 2026.',
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
      desc: 'Ebda Store vs Shopify for a seller in Egypt: where each is stronger and what Ebda Store does not have yet. As of November 2026.',
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

  /* ---- Egyptian alternatives. Every figure below was read on CHECKED_ON from the URL in `sources`;
   *      anything their pages do not state says "unverified" instead of a guess. ---- */
  const wuilt: Record<Locale, CompareCopy> = {
    ar: {
      name: 'ويلت',
      title: 'ابدأ ستور مقابل ويلت',
      desc: 'مقارنة صريحة بين ابدأ ستور وويلت لبائع في مصر: ويلت أرخص لو لسه بتبدأ، وابدأ ستور بيدّيك الدفع والشحن والذكاء الاصطناعي. بتاريخ 2 نوفمبر 2026.',
      h1: 'ابدأ ستور مقابل ويلت',
      intro:
        'ويلت منصة مركّزة على مصر وفيها متجر مجاني. دي ميزة حقيقية لو لسه بتبدأ. الجدول ده بيقولك فين ويلت أرخص وفين ابدأ ستور أقوى، والأرقام مأخوذة من صفحاتهم العامة بتاريخ 2 نوفمبر 2026.',
      chooseThemH: 'اختار ويلت لو',
      chooseThem: [
        'لسه بتبدأ وطلباتك قليلة وماعندكش حد بمرتب بيرد على الرسايل: المتجر المجاني ما بيكلفكش حاجة، وابدأ ستور بيبدأ من 1,490 ج.م في الشهر.',
        'محتاج متجر بسيط بصفحات قليلة وعايز تجرّب من غير ما تدفع.',
      ],
      chooseEbdaH: 'اختار ابدأ ستور لو',
      chooseEbda: [
        ...ebdaChoiceAr,
        'بتاخد طلبات كتير بالرسايل وعايز اللينك ياخد الطلب لوحده وتوفّر مرتب اللي بيرد.',
      ],
      linkText: 'ابدأ ستور مقابل ويلت',
    },
    en: {
      name: 'Wuilt',
      title: 'Ebda Store vs Wuilt',
      desc: 'Ebda Store vs Wuilt for a seller in Egypt: Wuilt is cheaper when starting out; Ebda Store adds payments, shipping and AI. Checked 2 Nov 2026.',
      h1: 'Ebda Store vs Wuilt',
      intro:
        'Wuilt is an Egypt-focused platform with a free store, which is a real advantage when you are starting out. This page says where Wuilt is cheaper and where Ebda Store is stronger. Figures come from their public pages, checked 2 November 2026.',
      chooseThemH: 'Choose Wuilt if',
      chooseThem: [
        'You are starting out, sell few orders and have nobody on payroll answering messages: the free store costs nothing, while Ebda Store starts at EGP 1,490 a month.',
        'You need a simple store with a few pages and want to try it without paying.',
      ],
      chooseEbdaH: 'Choose Ebda Store if',
      chooseEbda: [
        ...ebdaChoiceEn,
        'You take many orders by message and want the link to take the order by itself, so you save the salary of the person answering.',
      ],
      linkText: 'Ebda Store vs Wuilt',
    },
  };
  const wuiltCells = them(
    {
      ...vendorCells('Wuilt', 'ويلت'),
      market: same(
        'Egypt-focused: its homepage says Wuilt stores are free for life for Wuilt customers in Egypt.',
        'مركّزة على مصر: صفحتها الرئيسية بتقول إن متاجر ويلت مجانية مدى الحياة لعملاء ويلت في مصر.'
      ),
      currency: same(
        'There is a free store. Paid plans are billed annually and listed in dollars with pound equivalents: Personal EGP 1,250 a year, Basic EGP 7,500, Premium EGP 10,500, Business EGP 17,500 (plan cards on its pricing page; the top plan is now named Business). Cheaper than Ebda Store at the entry level.',
        'فيه متجر مجاني. الباقات المدفوعة بتتدفع سنويًا ومتسعّرة بالدولار مع المعادل بالجنيه: الشخصية 1,250 ج.م في السنة، والأساسية 7,500، والمميزة 10,500، والاحترافية 17,500 (من كروت الباقات في صفحة الأسعار). أرخص من ابدأ ستور في أول الطريق.'
      ),
      commission: same(
        'Its pricing page does not state a commission on orders. Unverified.',
        'صفحة الأسعار عندهم مش بتذكر عمولة على الطلبات. غير مؤكد.'
      ),
      arabic: same(
        'Arabic-first: it calls itself the fastest way to design an online store in the Arab world.',
        'عربية من الأساس: بتوصف نفسها إنها أسرع طريقة لتصميم متجر إلكتروني في العالم العربي.'
      ),
      payments: same(
        'Says you can connect different electronic payment methods and ship with the largest carriers in Egypt. It names no gateway or carrier, and cash on delivery and InstaPay are not stated. Unverified.',
        'بتقول إنك تقدر توصّل وسائل دفع إلكترونية مختلفة وتشحن مع أكبر شركات الشحن في مصر. من غير ما تسمّي بوابة أو شركة، والدفع عند الاستلام وإنستا باي مش مذكورين. غير مؤكد.'
      ),
      ai: same(
        'AI features are not stated on its homepage. Unverified.',
        'أدوات الذكاء الاصطناعي مش مذكورة في صفحتها الرئيسية. غير مؤكد.'
      ),
      builder: same(
        'A store builder managed from one dashboard and from your phone. Paid plans cap pages and languages: Basic has 10 pages and 2 languages, Premium 20 pages and 4.',
        'منشئ متاجر بتديره من لوحة واحدة ومن الموبايل. الباقات المدفوعة ليها حد للصفحات واللغات: الأساسية 10 صفحات ولغتين، والمميزة 20 صفحة و4 لغات.'
      ),
      ecosystem: same(
        'Its homepage claims more than 350 thousand customers worldwide (its own figure, not verified by us).',
        'صفحتها الرئيسية بتقول أكتر من 350 ألف عميل حول العالم (رقمهم هم، ومش متأكدين منه).'
      ),
    },
    { currency: 'them', ecosystem: 'them' }
  );

  const youcan: Record<Locale, CompareCopy> = {
    ar: {
      name: 'يوكان',
      title: 'ابدأ ستور مقابل يوكان',
      desc: 'مقارنة صريحة بين ابدأ ستور ويوكان لبائع في مصر: يوكان بالدولار من غير رسوم معاملات على باقاته، وابدأ ستور بالجنيه وصفر عمولة. 2 نوفمبر 2026.',
      h1: 'ابدأ ستور مقابل يوكان',
      intro:
        'يوكان منصة بتخدم تجار في دول كتير، وباقاتها بالدولار وباقاتها المدفوعة من غير رسوم معاملات. ابدأ ستور بالجنيه وبصفر عمولة. الأرقام مأخوذة من صفحاتهم العامة بتاريخ 2 نوفمبر 2026.',
      chooseThemH: 'اختار يوكان لو',
      chooseThem: [
        'بتبيع في أكتر من دولة وعايز باقة بالدولار على حسب حجم المبيعات.',
        'محتاج حاجة مش موجودة في ابدأ ستور لسه، وتأكدت إنها متاحة عندهم.',
      ],
      chooseEbdaH: 'اختار ابدأ ستور لو',
      chooseEbda: ebdaChoiceAr,
      linkText: 'ابدأ ستور مقابل يوكان',
    },
    en: {
      name: 'YouCan',
      title: 'Ebda Store vs YouCan',
      desc: 'Ebda Store vs YouCan for a seller in Egypt: dollar plans at YouCan (no transaction fees on paid plans), pounds and 0% commission at Ebda Store. 2 Nov 2026.',
      h1: 'Ebda Store vs YouCan',
      intro:
        'YouCan serves merchants in many countries and bills its plans in dollars; its paid plans show no transaction fees. Ebda Store bills in pounds with 0% commission. Figures come from their public pages, checked 2 November 2026.',
      chooseThemH: 'Choose YouCan if',
      chooseThem: [
        'You sell in more than one country and want a dollar plan sized to your sales.',
        'You need something Ebda Store lacks and you have confirmed they offer it.',
      ],
      chooseEbdaH: 'Choose Ebda Store if',
      chooseEbda: ebdaChoiceEn,
      linkText: 'Ebda Store vs YouCan',
    },
  };
  const youcanCells = them(
    {
      ...vendorCells('YouCan', 'يوكان'),
      market: same(
        'Its homepage says it serves 166+ countries. It does not say where it is based and does not mention Egypt.',
        'صفحتها الرئيسية بتقول إنها بتخدم أكتر من 166 دولة. مش بتقول مقرها فين ومش بتذكر مصر.'
      ),
      currency: same(
        'Plans are priced in dollars ($ shown): Solopreneur $29, Starter $49, Entrepreneur $89 and Premium $149 a month, and an Unlimited plan (up to 5 stores) at $229 a month, with a lower yearly price. No pound price is shown.',
        'الباقات متسعّرة بالدولار: Solopreneur بـ29$ وStarter بـ49$ وEntrepreneur بـ89$ وPremium بـ149$ في الشهر، وفيه باقة Unlimited (لحد 5 متاجر) بـ229$ في الشهر، وفيه سعر أقل للسنوي. مفيش سعر بالجنيه.'
      ),
      commission: same(
        'The paid subscription plans show $0 in transaction fees. The fees (cash on delivery 0.5% and online payment 1% on the first $5K, then 0.25% and 0.5% above $5K) apply only to its separate pay-as-you-go option, which has no monthly price. Plans also cap monthly sales, from up to $50K to unlimited.',
        'باقات الاشتراك المدفوعة مكتوب عندها 0$ رسوم معاملات. الرسوم (0.5% على الدفع عند الاستلام و1% على الدفع الأونلاين لأول 5 آلاف دولار، وبعدها 0.25% و0.5%) بتنطبق بس على خيار الدفع حسب الاستخدام المنفصل عندهم، وده من غير سعر شهري. والباقات ليها حد مبيعات شهري من 50 ألف دولار لحد غير محدود.'
      ),
      arabic: same(
        'The language menu lists English, French and Arabic.',
        'قايمة اللغات فيها الإنجليزي والفرنسي والعربي.'
      ),
      payments: same(
        'YouCan Ship offers a list of local shipping companies, none named on its homepage. Cash on delivery and Egyptian gateways are not stated. Unverified.',
        'يوكان شيب بتقدّم قايمة شركات شحن محلية، ومفيش اسم منها في الصفحة الرئيسية. الدفع عند الاستلام والبوابات المصرية مش مذكورين. غير مؤكد.'
      ),
    },
    { commission: 'ebda' }
  );

  const easyorders: Record<Locale, CompareCopy> = {
    ar: {
      name: 'إيزي أوردرز',
      title: 'ابدأ ستور مقابل إيزي أوردرز',
      desc: 'مقارنة صريحة بين ابدأ ستور وإيزي أوردرز لبائع في مصر: أسعار إيزي أوردرز ماقدرناش نتأكد منها في 2 نوفمبر 2026، وابدأ ستور بيدّيك متجر كامل بالجنيه وبصفر عمولة.',
      h1: 'ابدأ ستور مقابل إيزي أوردرز',
      intro:
        'إيزي أوردرز عنده خطة مجانية وخطة ثابتة. ماقدرناش نوصل لصفحة الأسعار عندهم في 2 نوفمبر 2026، فمش هنكتب أرقام ليه: شوف موقعهم للأسعار الحالية. الجدول ده بيقولك فين ممكن يناسبك وفين ابدأ ستور أقوى.',
      chooseThemH: 'اختار إيزي أوردرز لو',
      chooseThem: [
        'طلباتك قليلة وعايز تبدأ بخطة مجانية (شوف موقعهم لتكلفة الطلب النهاردة).',
        'عندك مطوّر وعايز واجهة برمجية وتوثيق للقوالب.',
      ],
      chooseEbdaH: 'اختار ابدأ ستور لو',
      chooseEbda: ebdaChoiceAr,
      linkText: 'ابدأ ستور مقابل إيزي أوردرز',
    },
    en: {
      name: 'EasyOrders',
      title: 'Ebda Store vs EasyOrders',
      desc: 'Ebda Store vs EasyOrders for a seller in Egypt: EasyOrders prices could not be verified on 2 Nov 2026; Ebda Store is in pounds, 0% commission.',
      h1: 'Ebda Store vs EasyOrders',
      intro:
        'EasyOrders offers a free plan and a fixed plan. We could not reach its pricing page on 2 November 2026, so this page shows no prices for it: check their site for the current ones. It says where it may suit you and where Ebda Store is stronger.',
      chooseThemH: 'Choose EasyOrders if',
      chooseThem: [
        'You take few orders and want to start on a free plan (check their site for what it costs per order today).',
        'You have a developer and want a public API and theme documentation.',
      ],
      chooseEbdaH: 'Choose Ebda Store if',
      chooseEbda: ebdaChoiceEn,
      linkText: 'Ebda Store vs EasyOrders',
    },
  };
  const easyordersCells = them(
    {
      ...vendorCells('EasyOrders', 'إيزي أوردرز'),
      market: same(
        'Its site is in Arabic with an Egypt market selector; it also lists global, Morocco and Algeria.',
        'موقعها بالعربي وفيه اختيار لسوق مصر، وبتعرض كمان العالمي والمغرب والجزائر.'
      ),
      currency: same(
        'Prices are in dollars. A free plan and a fixed plan are listed. We could not verify the figures on 2 November 2026: check their site.',
        'الأسعار بالدولار. فيه خطة مجانية وخطة ثابتة. ماقدرناش نتأكد من الأرقام في 2 نوفمبر 2026: شوف موقعهم.'
      ),
      commission: same(
        'The fixed plan says no commission on orders. The fee on the free plan could not be verified on 2 November 2026: check their site.',
        'الخطة الثابتة مكتوب فيها بدون عمولة على الطلبات. ورسم الخطة المجانية ماقدرناش نتأكد منه في 2 نوفمبر 2026: شوف موقعهم.'
      ),
      arabic: same('The site and its pricing page are in Arabic.', 'الموقع وصفحة الأسعار بالعربي.'),
      builder: same(
        'Both plans list unlimited products, orders and visits, and a lifetime-active store. Theme and funnel documentation is published for developers.',
        'الخطتين فيهم منتجات وطلبات وزيارات غير محدودة ومتجر شغال مدى الحياة. وفيه توثيق للقوالب والصفحات الهابطة للمطورين.'
      ),
      integrations: same(
        'A public API is listed for developers.',
        'فيه واجهة برمجية عامة للمطورين.'
      ),
      code: same(
        'Public API and theme documentation are listed for developers.',
        'الواجهة البرمجية وتوثيق القوالب متاحين للمطورين.'
      ),
    },
    // currency stays neutral: the EasyOrders prices could not be verified on 2 November 2026 (Ruling COMPARE-1)
    { integrations: 'them', code: 'them' }
  );

  const expandcart: Record<Locale, CompareCopy> = {
    ar: {
      name: 'إكسباند كارت',
      title: 'ابدأ ستور مقابل إكسباند كارت',
      desc: 'مقارنة صريحة بين ابدأ ستور وإكسباند كارت لبائع في مصر: إكسباند كارت بالجنيه وبعملات متعددة، وابدأ ستور مبني لمصر. بتاريخ 2 نوفمبر 2026.',
      h1: 'ابدأ ستور مقابل إكسباند كارت',
      intro:
        'إكسباند كارت بيقول إنه من غير عمولات على المبيعات، وفيه عملات متعددة وتكاملات كتير. ابدأ ستور بالجنيه ومبني لمصر. الأرقام من صفحاتهم العامة بتاريخ 2 نوفمبر 2026.',
      chooseThemH: 'اختار إكسباند كارت لو',
      chooseThem: [
        'بتبيع بأكتر من عملة، أو محتاج نقطة بيع وتطبيقات دروبشيبنج جاهزة.',
        'محتاج حاجة مش موجودة في ابدأ ستور لسه، وتأكدت إنها متاحة عندهم.',
      ],
      chooseEbdaH: 'اختار ابدأ ستور لو',
      chooseEbda: ebdaChoiceAr,
      linkText: 'ابدأ ستور مقابل إكسباند كارت',
    },
    en: {
      name: 'ExpandCart',
      title: 'Ebda Store vs ExpandCart',
      desc: 'Ebda Store vs ExpandCart for a seller in Egypt: pound prices served in Egypt and many currencies at ExpandCart; pounds and Egypt-first at Ebda Store.',
      h1: 'Ebda Store vs ExpandCart',
      intro:
        'ExpandCart says it takes no commission on sales, and it offers multiple currencies and many integrations. Ebda Store bills in pounds and is built for Egypt. Figures come from their public pages, checked 2 November 2026.',
      chooseThemH: 'Choose ExpandCart if',
      chooseThem: [
        'You sell in more than one currency, or need a point of sale and ready dropshipping apps.',
        'You need something Ebda Store lacks and you have confirmed they offer it.',
      ],
      chooseEbdaH: 'Choose Ebda Store if',
      chooseEbda: ebdaChoiceEn,
      linkText: 'Ebda Store vs ExpandCart',
    },
  };
  const expandcartCells = them(
    {
      ...vendorCells('ExpandCart', 'إكسباند كارت'),
      market: same(
        'Where it is based is not stated on its pricing page. Unverified. The site is in English and Arabic.',
        'صفحة الأسعار مش بتقول مقرها فين. غير مؤكد. والموقع بالإنجليزي والعربي.'
      ),
      currency: same(
        'Served in pounds to visitors in Egypt (as of November 2026): Standard EGP 599, Professional EGP 1,199 and Ultimate EGP 4,599 a month, or EGP 5,999, 11,999 and 45,999 a year. The dollar prices were not re-checked.',
        'بتتعرض بالجنيه لزوار مصر (بتاريخ نوفمبر 2026): Standard بـ599 ج.م وProfessional بـ1,199 ج.م وUltimate بـ4,599 ج.م في الشهر، أو 5,999 و11,999 و45,999 ج.م في السنة. أسعار الدولار ماتراجعتش.'
      ),
      commission: same(
        'Its pricing page says no commissions no matter how big your sales are.',
        'صفحة الأسعار بتقول من غير عمولات مهما كبرت مبيعاتك.'
      ),
      arabic: same(
        'Multi-language is listed on the Standard plan, and the site is in English and Arabic.',
        'تعدد اللغات مكتوب في باقة Standard، والموقع بالإنجليزي والعربي.'
      ),
      payments: same(
        'Lists 100+ payment and shipping integrations. Which of them are Egyptian is not stated. Unverified.',
        'بتعرض أكتر من 100 تكامل للدفع والشحن. مش مذكور أنهي منهم مصري. غير مؤكد.'
      ),
      builder: same(
        'Standard includes 1 template and an advanced template editor with up to 100 products; Professional has 4 templates and up to 1,000 products.',
        'Standard فيها قالب واحد ومحرر قوالب متقدم وحتى 100 منتج، وProfessional فيها 4 قوالب وحتى 1,000 منتج.'
      ),
      integrations: same(
        'Facebook Pixel on Standard and Google Analytics on Professional are listed.',
        'Facebook Pixel في Standard وGoogle Analytics في Professional.'
      ),
      apps: same(
        'Free marketing and SEO apps are listed on Professional, and free dropshipping apps (Knawat on Standard, AliExpress on Professional).',
        'تطبيقات تسويق وSEO مجانية في Professional، وتطبيقات دروبشيبنج مجانية (Knawat في Standard وAliExpress في Professional).'
      ),
      pos: same(
        'Its navigation lists a point-of-sale option under Sell.',
        'القايمة عندهم فيها نقطة بيع تحت Sell.'
      ),
      multicur: same(
        'Multi-currency is listed on the Standard plan.',
        'العملات المتعددة مكتوبة في باقة Standard.'
      ),
    },
    { apps: 'them', pos: 'them', multicur: 'them' }
  );

  return {
    zid: { ...zid, cells: them(vendorCells('Zid', 'زد')) },
    shopify: { ...shopify, cells: shopifyCells },
    wuilt: {
      ...wuilt,
      cells: wuiltCells,
      sources: [
        { name: 'wuilt.com/pricing', href: 'https://wuilt.com/pricing' },
        { name: 'wuilt.com', href: 'https://wuilt.com' },
      ],
    },
    youcan: {
      ...youcan,
      cells: youcanCells,
      sources: [
        { name: 'youcan.shop/pricing', href: 'https://www.youcan.shop/pricing' },
        { name: 'youcan.shop', href: 'https://www.youcan.shop/' },
      ],
    },
    easyorders: {
      ...easyorders,
      cells: easyordersCells,
      sources: [{ name: 'easyorders.eg/pricing', href: 'https://www.easyorders.eg/pricing' }],
    },
    expandcart: {
      ...expandcart,
      cells: expandcartCells,
      sources: [
        { name: 'expandcart.com/en/pricing-2', href: 'https://expandcart.com/en/pricing-2/' },
      ],
    },
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
    sourcesH: string;
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
    sourcesH: `المصادر (اتقرت بتاريخ ${CHECKED_ON_AR}):`,
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
    sourcesH: `Sources (read ${CHECKED_ON}):`,
    verdict: {
      ebda: 'Ebda Store stronger',
      them: 'Stronger there',
      even: 'Comparable, or compare yourself',
    },
  },
};
