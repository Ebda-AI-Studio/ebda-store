import type { Locale } from './site';

/**
 * What Ebda Store can do, for /features and the home capabilities section. Every entry is
 * backed by code (evidence paths in .superpowers/marketing-report.md); anything not provable
 * from the repo is left out. Plan notes follow the one plan catalogue (plans.ts /
 * packages/shared plan-limits + plan-baselines): custom domain is on every plan, cart recovery,
 * loyalty and the AI assistant start at Growth, multi-warehouse and affiliates are Business.
 */
export interface CapabilityCopy {
  /** Short card title. */
  t: string;
  /** One or two full sentences. */
  d: string;
  /** Which plans have it, when it is not every plan. */
  plan?: string;
}

export type CapabilityId =
  | 'builder'
  | 'domain'
  | 'ai'
  | 'search'
  | 'seo'
  | 'assistant'
  | 'cart'
  | 'emails'
  | 'loyalty'
  | 'reviews'
  | 'analytics'
  | 'warehouse'
  | 'payments'
  | 'commission';

/** Order = order on /features. The first `HOME_CAPABILITY_COUNT` also show on the home page. */
export const CAPABILITY_IDS: readonly CapabilityId[] = [
  'builder',
  'domain',
  'ai',
  'search',
  'seo',
  'assistant',
  'cart',
  'emails',
  'loyalty',
  'reviews',
  'analytics',
  'warehouse',
  'payments',
  'commission',
] as const;

/** Home cards, in order: the ones shoppers and AI assistants ask about most. */
export const HOME_CAPABILITIES: readonly CapabilityId[] = [
  'builder',
  'domain',
  'ai',
  'search',
  'seo',
  'cart',
  'loyalty',
  'commission',
] as const;

export const CAPABILITIES: Record<Locale, Record<CapabilityId, CapabilityCopy>> = {
  ar: {
    builder: {
      t: 'قوالب وأشكال جاهزة ومحرر صفحات',
      d: 'اختار من خمس قوالب، وكل قالب فيه ثلاث أشكال جاهزة، وبعدين عدّل الألوان والصور وترتيب الأقسام من محرر صفحات بتشوف فيه التغيير قدامك على طول، من غير مبرمج.',
    },
    domain: {
      t: 'لينك مجاني ودومين خاص بيك',
      d: 'كل متجر بيطلع على لينك مجاني بالشكل ده: yourname.ebda.app، وتقدر تربط دومينك الخاص من لوحة التحكم، وده متاح في كل الباقات.',
    },
    ai: {
      t: 'الذكاء الاصطناعي بيكتب ويترجم ويحسّن',
      d: 'بيكتب وصف المنتجات ويترجمها عربي وإنجليزي، ويقترح كلمات بحث وتصنيفات ووسوم ونص بديل للصور، ويجهّز عناوين وأوصاف لمحركات البحث وأسئلة شائعة. إنت اللي بتراجع وتنشر.',
      plan: 'مشمول في الباقات المدفوعة، ضمن حدود الاستخدام العادل',
    },
    search: {
      t: 'بحث بيفهم المصري والفرانكو',
      d: 'البحث في متجرك بيعتبر الهمزة والألف حاجة واحدة، والتاء المربوطة والهاء، والياء والألف المقصورة، ويتجاهل التشكيل. والذكاء الاصطناعي بيضيف لكل منتج كلمات بالعامية المصرية وبالفرانكو وبالإنجليزي، فالعميل اللي يكتب "gazma" يلاقي الجزمة.',
    },
    seo: {
      t: 'SEO وظهور في إجابات الذكاء الاصطناعي',
      d: 'عناوين وأوصاف لمحركات البحث، وتحويلات للينكات القديمة، وأسئلة شائعة منظّمة، وملف llms.txt لمتجرك، وفيد منتجات تقراه مساعدات الذكاء الاصطناعي. وكمان تقدر تتابع هل مساعدات الذكاء الاصطناعي، زي ChatGPT وGemini وPerplexity، بتذكر متجرك.',
    },
    assistant: {
      t: 'شغّل متجرك من مساعد ذكاء اصطناعي',
      d: 'وصّل مساعدك المفضل بمتجرك، واطلب منه يضيف منتجات ويعدّل أسعار ويراجع الطلبات بدل ما تفتح لوحة التحكم.',
      plan: 'باقتا النمو والأعمال',
    },
    cart: {
      t: 'استرجاع السلات المتروكة',
      d: 'لو عميل ساب منتجات في السلة، المتجر بيفكّره على خطوات ويرجّعه للسلة بلينك مباشر، بإشعار، أو برسالة SMS لو العميل وافق على استلامها.',
      plan: 'باقتا النمو والأعمال',
    },
    emails: {
      t: 'إيميلات الطلبات بتتبعت لوحدها',
      d: 'تأكيد الطلب، والشحن، والاسترجاع، ونجاح الدفع أو فشله، وطلب تقييم بعد الاستلام، كلها بتتبعت لعميلك بالعربي أو الإنجليزي بشكل متناسق مع شكل متجرك.',
    },
    loyalty: {
      t: 'نقاط ولاء ومكافآت إحالة وعمولة مسوّقين',
      d: 'العميل بيكسب نقاط على كل جنيه بيصرفه، وعلى التسجيل والتقييم وعيد الميلاد والإحالة، وبيترقى بين أربع مستويات. وللمتاجر الكبيرة برنامج مسوّقين بعمولة بتحددها إنت.',
      plan: 'النقاط في النمو والأعمال، وبرنامج المسوّقين في الأعمال',
    },
    reviews: {
      t: 'تقييمات العملاء',
      d: 'العميل بيقيّم المنتج بعد ما يستلمه، وانت بتراجع التقييمات قبل ما تظهر في المتجر.',
    },
    analytics: {
      t: 'تحليلات وإحصائيات بحث',
      d: 'اعرف إيه اللي بيتباع، وإيه اللي العملاء بيدوّروا عليه ومش لاقيينه، وإيرادات متجرك. مستوى التفاصيل بيزيد مع الباقة.',
    },
    warehouse: {
      t: 'أكتر من مخزن وأوامر شراء',
      d: 'لو عندك أكتر من مخزن، تابع المخزون في كل واحد، واعمل أوامر شراء من الموردين، وامسح باركود المنتجات.',
      plan: 'باقة الأعمال',
    },
    payments: {
      t: 'دفع وشحن زي ما السوق المصري متعود',
      d: 'الدفع عند الاستلام، وإنستا باي، والكارت والمحفظة عن طريق Paymob وKashier وFawryPay. والشحن مع بوسطة وShipBlu ومايلرز وأرامكس، أو توصّل بنفسك.',
    },
    commission: {
      t: 'صفر عمولة على طلباتك',
      d: 'بتدفع الاشتراك بس، من غير عمولة على أي طلب في أي باقة. رسوم بوابة الدفع بتتحسب منفصلة لو العميل دفع أونلاين.',
    },
  },
  en: {
    builder: {
      t: 'Templates, ready-made looks and a page builder',
      d: 'Pick from five templates with three ready-made looks each, then change colours, photos and the order of sections in a page builder where you see every change as you make it. No developer needed.',
    },
    domain: {
      t: 'A free address and your own domain',
      d: 'Every store gets a free yourname.ebda.app address, and you can connect your own domain from the dashboard. A custom domain is available on every plan.',
    },
    ai: {
      t: 'AI that writes, translates and optimises',
      d: 'It writes product descriptions and translates them between Arabic and English, suggests search words, categories, tags and image alt text, and drafts search-engine titles, descriptions and FAQs. You review and publish.',
      plan: 'Included in the paid plans, within fair-use limits',
    },
    search: {
      t: 'Search that understands Egyptian Arabic and Franco',
      d: 'Store search treats alef forms, taa marbuta and haa, and yaa and alef maqsura as the same letters, and ignores diacritics. AI also adds Egyptian-dialect, Franco-Arabic and English search words to each product, so a shopper typing "gazma" finds the shoes.',
    },
    seo: {
      t: 'SEO and visibility in AI answers',
      d: 'Search-engine titles and descriptions, redirects for old links, structured FAQs, an llms.txt file for your store and a product feed that AI assistants can read. You can also track whether AI assistants, such as ChatGPT, Gemini and Perplexity, mention your store.',
    },
    assistant: {
      t: 'Run your store from an AI assistant',
      d: 'Connect your favourite assistant to your store and ask it to add products, change prices and review orders instead of opening the dashboard.',
      plan: 'Growth and Business plans',
    },
    cart: {
      t: 'Abandoned-cart recovery',
      d: 'When a shopper leaves items in the cart, the store reminds them in steps and sends them back to the cart with a direct link, by notification or by SMS when the shopper agreed to receive it.',
      plan: 'Growth and Business plans',
    },
    emails: {
      t: 'Order emails that send themselves',
      d: 'Order confirmation, shipping, refunds, payment success or failure and a review request after delivery all go to your customer in Arabic or English, styled to match your store.',
    },
    loyalty: {
      t: 'Loyalty points, referral rewards and affiliates',
      d: 'Customers earn points on every pound they spend and for signing up, reviewing, birthdays and referrals, and move up through four tiers. Larger stores can also run an affiliate programme with a commission you set.',
      plan: 'Points on Growth and Business, affiliate programme on Business',
    },
    reviews: {
      t: 'Customer reviews',
      d: 'Customers review a product after it arrives, and you moderate reviews before they appear on your store.',
    },
    analytics: {
      t: 'Analytics and search insights',
      d: 'See what sells, what shoppers search for and cannot find, and your store revenue. The level of detail grows with the plan.',
    },
    warehouse: {
      t: 'Multiple warehouses and purchase orders',
      d: 'If you keep stock in more than one place, track inventory per warehouse, raise purchase orders to suppliers and scan product barcodes.',
      plan: 'Business plan',
    },
    payments: {
      t: 'Payments and shipping the Egyptian market expects',
      d: 'Cash on delivery, InstaPay, and card and wallet payments through Paymob, Kashier and FawryPay. Shipping with Bosta, ShipBlu, Mylerz and Aramex, or deliver yourself.',
    },
    commission: {
      t: '0% commission on your orders',
      d: 'You pay the subscription only, with no commission on any order on any plan. Payment gateway fees are separate when a customer pays online.',
    },
  },
};

/** More, smaller things that are real, as one compact list on /features. */
export const MORE: Record<Locale, { title: string; items: string[] }> = {
  ar: {
    title: 'وكمان',
    items: [
      'كوبونات وعروض، وتقدر تستهدف بيها مجموعات عملاء',
      'مرتجعات من لوحة التحكم',
      'حسابات للفريق بصلاحيات',
      'استيراد المنتجات بالجملة من ملف CSV أو Excel',
      'تتبع إعلانات Meta وTikTok من جهة السيرفر',
      'موديلات 3D والواقع المعزز لمنتجاتك في كل الباقات',
      'لوحة تحكم بتتثبّت على الموبايل وتبعتلك إشعار مع كل طلب',
    ],
  },
  en: {
    title: 'And also',
    items: [
      'Coupons and promotions, which can target customer groups',
      'Returns handled from the dashboard',
      'Team accounts with roles',
      'Bulk product import from CSV or Excel',
      'Server-side Meta and TikTok ad conversion tracking',
      '3D product models and AR on every plan',
      'A dashboard you install on your phone that notifies you of every order',
    ],
  },
};

export interface FeaturesFaqItem {
  q: string;
  a: string;
}

export const FEATURES_FAQ: Record<Locale, FeaturesFaqItem[]> = {
  ar: [
    {
      q: 'هل ابدأ ستور فيه قوالب وتصميمات جاهزة؟',
      a: 'أيوه. فيه خمس قوالب، وكل قالب ليه ثلاث أشكال جاهزة، وتقدر تعدّل الألوان والصور والأقسام من محرر الصفحات.',
    },
    {
      q: 'أقدر أربط دومين خاص بيا؟',
      a: 'أيوه، في كل الباقات. ولو مش عايز دلوقتي، متجرك بيشتغل على لينك مجاني yourname.ebda.app.',
    },
    {
      q: 'فيه استرجاع للسلات المتروكة؟',
      a: 'أيوه، في باقتي النمو والأعمال. المتجر بيفكّر العميل على خطوات بإشعار، أو برسالة SMS لو العميل وافق عليها. ولسه مفيش تذكير بالإيميل.',
    },
    {
      q: 'فيه نقاط ولاء وبرنامج إحالة؟',
      a: 'أيوه. نقاط الولاء والمستويات ومكافآت الإحالة في باقتي النمو والأعمال، وبرنامج المسوّقين بالعمولة في باقة الأعمال.',
    },
    {
      q: 'فيه حملات إيميل لمشتركي النشرة؟',
      a: 'الإيميلات التلقائية للطلبات شغالة في كل الباقات: تأكيد وشحن واسترجاع وطلب تقييم. أما حملات الإيميل التسويقية فمبنية في لوحة التحكم، بس لسه مش جزء من الباقات، وبنفعّلها لكل متجر على حدة.',
    },
    {
      q: 'البحث بيفهم العامية المصرية والفرانكو؟',
      a: 'أيوه. البحث بيوحّد أشكال الحروف العربية، والذكاء الاصطناعي بيضيف لكل منتج كلمات بحث بالعامية والفرانكو والإنجليزي.',
    },
    {
      q: 'الذكاء الاصطناعي مشمول في السعر؟',
      a: 'أيوه، أدوات الذكاء الاصطناعي مشمولة في الباقات المدفوعة، ضمن حدود الاستخدام العادل، ومن غير اشتراك منفصل.',
    },
    {
      q: 'فيه عمولة على الطلبات؟',
      a: 'لأ، صفر عمولة في كل الباقات. بتدفع الاشتراك بس، وبوابة الدفع بتاخد رسومها لو العميل دفع أونلاين.',
    },
    {
      q: 'إيه اللي لسه مش موجود؟',
      a: 'مفيش متجر تطبيقات، ولا محرر أكواد مخصص، ولا قوائم أسعار جملة لتجار الجملة، ولا نقطة بيع POS، ولا متجر بعملات متعددة. تفاصيل المقارنة مع سلة وزد وشوبيفاي في صفحات المقارنة.',
    },
  ],
  en: [
    {
      q: 'Does Ebda Store have templates and ready-made designs?',
      a: 'Yes. There are five templates with three ready-made looks each, and you can change colours, photos and sections in the page builder.',
    },
    {
      q: 'Can I connect my own domain?',
      a: 'Yes, on every plan. If you would rather wait, your store runs on a free yourname.ebda.app address.',
    },
    {
      q: 'Does it recover abandoned carts?',
      a: 'Yes, on the Growth and Business plans. The store reminds the shopper in steps by notification, or by SMS if the shopper agreed to it. There is no cart reminder by email yet.',
    },
    {
      q: 'Is there loyalty and a referral programme?',
      a: 'Yes. Loyalty points, tiers and referral rewards are on Growth and Business, and the affiliate programme with commission is on Business.',
    },
    {
      q: 'Can I send email campaigns to newsletter subscribers?',
      a: 'Automatic order emails work on every plan: confirmation, shipping, refunds and a review request. Marketing email campaigns are built into the dashboard but are not part of the plans yet; we switch them on store by store.',
    },
    {
      q: 'Does search understand Egyptian Arabic and Franco?',
      a: 'Yes. Search unifies Arabic letter variants, and AI adds Egyptian-dialect, Franco-Arabic and English search words to each product.',
    },
    {
      q: 'Is AI included in the price?',
      a: 'Yes. The AI tools are included in the paid plans, within fair-use limits, with no separate subscription.',
    },
    {
      q: 'Is there a commission on orders?',
      a: 'No. It is 0% on every plan. You pay the subscription, and the payment gateway charges its own fee when a customer pays online.',
    },
    {
      q: 'What is not there yet?',
      a: 'There is no app marketplace, no custom code editor, no wholesale price lists for B2B, no point-of-sale and no multi-currency store. The comparison pages for Salla, Zid and Shopify go through the details.',
    },
  ],
};

export const FEATURES_PAGE: Record<
  Locale,
  {
    title: string;
    desc: string;
    h1: string;
    lead: string;
    planLabel: string;
    faqTitle: string;
    compareTitle: string;
    cta: string;
    homeTitle: string;
    homeLead: string;
    homeAll: string;
    navLabel: string;
  }
> = {
  ar: {
    title: 'مميزات ابدأ ستور',
    desc: 'قوالب ومحرر صفحات، دومين خاص، ذكاء اصطناعي، بحث بالعامية والفرانكو، SEO، استرجاع سلات، نقاط ولاء، تقييمات، تحليلات، ودفع وشحن للسوق المصري. صفر عمولة.',
    h1: 'كل اللي ابدأ ستور بيعمله.',
    lead: 'ده اللي موجود فعلًا النهاردة في ابدأ ستور من ابدأ استوديو للذكاء الاصطناعي. وكل حاجة لسه مش موجودة مكتوبة بصراحة في صفحات المقارنة.',
    planLabel: 'متاح في',
    faqTitle: 'أسئلة عن المميزات',
    compareTitle: 'قارن ابدأ ستور بغيره',
    cta: 'ابدأ دلوقتي',
    homeTitle: 'مش متجر بسيط وبس.',
    homeLead: 'قوالب، ذكاء اصطناعي، بحث بالمصري والفرانكو، استرجاع سلات ونقاط ولاء، وصفر عمولة.',
    homeAll: 'شوف كل المميزات',
    navLabel: 'كل المميزات',
  },
  en: {
    title: 'Ebda Store features',
    desc: 'Templates and a page builder, custom domain, AI tools, Egyptian Arabic and Franco search, SEO, abandoned-cart recovery, loyalty, reviews, analytics, and payments and shipping for Egypt. 0% commission.',
    h1: 'Everything Ebda Store does.',
    lead: 'This is what exists in Ebda Store today, from Ebda AI Studio. What is not there yet is listed honestly on the comparison pages.',
    planLabel: 'Available on',
    faqTitle: 'Questions about features',
    compareTitle: 'Compare Ebda Store',
    cta: 'Start now',
    homeTitle: 'More than a simple store.',
    homeLead:
      'Templates, AI, Egyptian Arabic and Franco search, cart recovery, loyalty points and 0% commission.',
    homeAll: 'See all features',
    navLabel: 'All features',
  },
};
