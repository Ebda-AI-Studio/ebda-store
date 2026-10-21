import type { Locale } from './site';
import { isLive, type CapabilityId } from './capability-registry';

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

export type { CapabilityId } from './capability-registry';

/** Order = order on /features. */
export const CAPABILITY_IDS: readonly CapabilityId[] = [
  'builder',
  'domain',
  'ai',
  'smartsearch',
  'searchwords',
  'meaning',
  'insights',
  'seo',
  'assistant',
  'cart',
  'cartemail',
  'emails',
  'campaigns',
  'webhooks',
  'loyalty',
  'reviews',
  'analytics',
  'warehouse',
  'barcodes',
  'b2b',
  'payments',
  'commission',
] as const;

/** Home cards, in order: the ones shoppers and AI assistants ask about most. */
export const HOME_CAPABILITIES: readonly CapabilityId[] = [
  'builder',
  'smartsearch',
  'searchwords',
  'meaning',
  'ai',
  'insights',
  'cart',
  'webhooks',
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
    smartsearch: {
      t: 'بحث ذكي بيفهم المصري والفرانكو',
      d: 'عميلك بيكتب زي ما بيتكلم: بالعامية المصرية، أو بالفرانكو زي "gazma" و"kotshy"، أو بالإنجليزي. والبحث بيفهم أشكال الحروف زي أ وا وه وة، وبيلاقي المنتج حتى لو الكتابة مش مظبوطة بالظبط.',
    },
    searchwords: {
      t: 'كلمات بحث بالذكاء الاصطناعي لكل منتج',
      d: 'كل منتج بياخد لوحده كلمات بحث بالمصري والفرانكو والإنجليزي وأشهر أخطاء الكتابة، من غير ما تكتبها إنت. وتقدر تعدّلها أو تضيف عليها في أي وقت.',
    },
    meaning: {
      t: 'بحث بالمعنى',
      d: 'العميل يكتب اللي في دماغه مش اسم المنتج بالظبط، والبحث يفهم قصده ويطلّعله المنتجات المناسبة. بنطرحه تدريجيًا، ومش بيتفعّل على متجرك غير لما نتأكد إن نتايجه ممتازة على منتجات حقيقية.',
    },
    insights: {
      t: 'اعرف عملاءك بيدوّروا على إيه',
      d: 'شوف إيه اللي عملاءك بحثوا عنه، وإيه اللي بحثوا عنه ومالقوش نتيجة، وبكده تعرف تضيف المنتج الناقص أو تظبّط كلمات البحث.',
    },
    seo: {
      t: 'SEO وظهور في إجابات الذكاء الاصطناعي',
      d: 'عناوين وأوصاف لمحركات البحث، وتحويلات للينكات القديمة، وأسئلة شائعة منظّمة، وملف llms.txt لمتجرك، وفيد منتجات تقراه مساعدات الذكاء الاصطناعي. وكمان تقدر تتابع هل مساعدات الذكاء الاصطناعي بتذكر متجرك.',
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
    cartemail: {
      t: 'تذكير السلة المتروكة بالإيميل',
      d: 'العميل بيوافق على استلام تذكير وهو بيدفع، حتى لو زائر من غير حساب، ولو سابك السلة بيوصله إيميل بلينك يرجّعه لسلته.',
      plan: 'ضمن استرجاع السلات المتروكة',
    },
    emails: {
      t: 'إيميلات الطلبات بتتبعت لوحدها',
      d: 'تأكيد الطلب، والشحن، والاسترجاع، ونجاح الدفع أو فشله، وطلب تقييم بعد الاستلام، كلها بتتبعت لعميلك بالعربي أو الإنجليزي بشكل متناسق مع شكل متجرك.',
    },
    campaigns: {
      t: 'حملات إيميل لمشتركيك',
      d: 'اكتب رسالة تسويقية بالعربي والإنجليزي وابعتها لمشتركي نشرتك اللي وافقوا على استلامها.',
      plan: 'باقتا النمو والأعمال',
    },
    webhooks: {
      t: 'اربط متجرك بأدواتك التانية',
      d: 'لما يحصل حاجة في متجرك زي طلب جديد، المتجر بيبعت إشعار للأداة اللي تحددها، فتقدر توصّله بنظام المحاسبة أو الشحن أو أي أداة بتشتغل بيها.',
      plan: 'باقتا النمو والأعمال',
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
      t: 'تحليلات متجرك',
      d: 'اعرف إيه اللي بيتباع وإيراداتك. مستوى التفاصيل بيزيد مع الباقة.',
    },
    warehouse: {
      t: 'أكتر من مخزن وأوامر شراء',
      d: 'لو عندك أكتر من مخزن، تابع المخزون في كل واحد، واعمل أوامر شراء من الموردين، وامسح باركود المنتجات.',
      plan: 'باقة الأعمال',
    },
    barcodes: {
      t: 'باركود للطلبات وبوليصة تغليف',
      d: 'كل طلب ليه باركود تمسحه فيفتح الطلب على طول، وبييجي في 23 شكل مبتكر. وفيه بوليصة تغليف عليها الباركود وطباعة بالجملة.',
    },
    b2b: {
      t: 'بيع بالجملة (B2B)',
      d: 'أسعار بتقل مع زيادة الكمية، ومجموعات عملاء، وحد أدنى للطلب، وموافقة منك على تاجر الجملة قبل ما يشتري.',
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
    smartsearch: {
      t: 'Smart search that understands Egyptian Arabic and Franco',
      d: 'Your shoppers type the way they talk: in Egyptian Arabic, in Franco like "gazma" or "kotshy", or in English. Search understands letter variants such as أ/ا and ه/ة, and still finds the product when the spelling is not exact.',
    },
    searchwords: {
      t: 'AI search words for every product',
      d: 'Every product gets its own search words in Egyptian Arabic, Franco and English, plus the common misspellings, without you typing them. You can edit or add to them at any time.',
    },
    meaning: {
      t: 'Search by meaning',
      d: 'Shoppers type what they have in mind, not the exact product name, and search understands what they mean. We are rolling it out gradually, and it only switches on for your store once its results pass our quality check on a real catalogue.',
    },
    insights: {
      t: 'See what your shoppers search for',
      d: 'See what shoppers searched for, and what they searched for and found nothing, so you can add the missing product or tune the search words.',
    },
    seo: {
      t: 'SEO and visibility in AI answers',
      d: 'Search-engine titles and descriptions, redirects for old links, structured FAQs, an llms.txt file for your store and a product feed that AI assistants can read. You can also track whether AI assistants mention your store.',
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
    cartemail: {
      t: 'Cart reminder emails',
      d: 'Shoppers opt in to a reminder at checkout, guests included, and if they leave the cart an email brings them straight back to it.',
      plan: 'Part of abandoned-cart recovery',
    },
    emails: {
      t: 'Order emails that send themselves',
      d: 'Order confirmation, shipping, refunds, payment success or failure and a review request after delivery all go to your customer in Arabic or English, styled to match your store.',
    },
    campaigns: {
      t: 'Email campaigns to your subscribers',
      d: 'Write a marketing email in Arabic and English and send it to newsletter subscribers who agreed to receive it.',
      plan: 'Growth and Business plans',
    },
    webhooks: {
      t: 'Connect your store to your other tools',
      d: 'When something happens in your store, such as a new order, it notifies the tool you choose, so you can connect it to your accounting, shipping or any other tool you work with.',
      plan: 'Growth and Business plans',
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
      t: 'Store analytics',
      d: 'See what sells and your revenue. The level of detail grows with the plan.',
    },
    warehouse: {
      t: 'Multiple warehouses and purchase orders',
      d: 'If you keep stock in more than one place, track inventory per warehouse, raise purchase orders to suppliers and scan product barcodes.',
      plan: 'Business plan',
    },
    barcodes: {
      t: 'Order barcodes and a packing slip',
      d: 'Every order has a barcode you scan to open it straight away, in 23 fun shapes. A packing slip carries the barcode, and you can print slips in bulk.',
    },
    b2b: {
      t: 'Wholesale selling (B2B)',
      d: 'Prices that drop as quantity grows, customer groups, minimum orders, and your approval of a wholesale buyer before they can order.',
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
  /** Answer when the item is live (or has no `needs`). */
  a: string;
  /** When set, the answer depends on this capability's status. */
  needs?: CapabilityId;
  /** Answer while `needs` is still coming. */
  aSoon?: string;
}

const FAQ_ITEMS: Record<Locale, FeaturesFaqItem[]> = {
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
      q: 'البحث بيفهم العامية المصرية والفرانكو؟',
      a: 'أيوه. العميل يكتب "gazma" أو "كوتشي" أو بالإنجليزي، والبحث بيفهم أشكال الحروف، وكل منتج بياخد كلمات بحث بالذكاء الاصطناعي تقدر تعدّلها.',
    },
    {
      q: 'فيه بحث بالمعنى؟',
      needs: 'meaning',
      a: 'أيوه. العميل يكتب اللي في دماغه والبحث يفهم قصده.',
      aSoon:
        'بنطرحه تدريجيًا وبيتفعّل قريبًا. مش هنفعّله على متجرك غير لما نتأكد إن نتايجه ممتازة على منتجات حقيقية.',
    },
    {
      q: 'فيه استرجاع للسلات المتروكة؟',
      needs: 'cartemail',
      a: 'أيوه، في باقتي النمو والأعمال. المتجر بيفكّر العميل على خطوات بالإيميل (لو وافق وهو بيدفع، حتى كزائر)، وبإشعار، وبرسالة SMS لو العميل وافق عليها.',
      aSoon:
        'أيوه، في باقتي النمو والأعمال. المتجر بيفكّر العميل على خطوات بإشعار، وبرسالة SMS لو العميل وافق عليها. والتذكير بالإيميل جاي قريبًا.',
    },
    {
      q: 'فيه نقاط ولاء وبرنامج إحالة؟',
      a: 'أيوه. نقاط الولاء والمستويات ومكافآت الإحالة في باقتي النمو والأعمال، وبرنامج المسوّقين بالعمولة في باقة الأعمال.',
    },
    {
      q: 'فيه حملات إيميل لمشتركي النشرة؟',
      needs: 'campaigns',
      a: 'أيوه، في باقتي النمو والأعمال. إيميلات الطلبات (تأكيد وشحن واسترجاع وطلب تقييم) شغالة في كل الباقات.',
      aSoon:
        'إيميلات الطلبات (تأكيد وشحن واسترجاع وطلب تقييم) شغالة في كل الباقات. وحملات الإيميل للمشتركين جاية قريبًا في باقتي النمو والأعمال.',
    },
    {
      q: 'أقدر أربط متجري بأدوات تانية؟',
      needs: 'webhooks',
      a: 'أيوه، في باقتي النمو والأعمال. المتجر بيبعت إشعار للأداة اللي تحددها لما يحصل حاجة زي طلب جديد.',
      aSoon:
        'ده جاي قريبًا في باقتي النمو والأعمال. مفيش متجر تطبيقات، لكن هتقدر توصّل متجرك بأدواتك.',
    },
    {
      q: 'فيه باركود للطلبات؟',
      needs: 'barcodes',
      a: 'أيوه. كل طلب ليه باركود في 23 شكل مبتكر، وبوليصة تغليف عليها الباركود وطباعة بالجملة.',
      aSoon:
        'جاي قريبًا: باركود لكل طلب في 23 شكل مبتكر، وبوليصة تغليف عليها الباركود وطباعة بالجملة.',
    },
    {
      q: 'أقدر أبيع بالجملة لتجار؟',
      needs: 'b2b',
      a: 'أيوه، في باقة الأعمال: أسعار بتقل مع الكمية، ومجموعات عملاء، وحد أدنى للطلب، وموافقة منك على تاجر الجملة.',
      aSoon:
        'جاي قريبًا في باقة الأعمال: أسعار بتقل مع الكمية، ومجموعات عملاء، وحد أدنى للطلب، وموافقة منك على تاجر الجملة. لحد ما ينزل مفيش قوائم أسعار جملة.',
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
      a: 'مفيش متجر تطبيقات، ولا محرر أكواد مخصص، ولا نقطة بيع POS، ولا متجر بعملات متعددة. وفي صفحات المقارنة مع سلة وزد وشوبيفاي هتلاقي التفاصيل، وإيه اللي جاي قريبًا.',
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
      q: 'Does search understand Egyptian Arabic and Franco?',
      a: 'Yes. A shopper can type "gazma", "كوتشي" or English, search understands letter variants, and every product gets AI search words that you can edit.',
    },
    {
      q: 'Is there search by meaning?',
      needs: 'meaning',
      a: 'Yes. Shoppers type what they have in mind and search understands what they mean.',
      aSoon:
        'It is rolling out gradually and coming soon. We will not switch it on for your store until its results pass our quality check on a real catalogue.',
    },
    {
      q: 'Does it recover abandoned carts?',
      needs: 'cartemail',
      a: 'Yes, on the Growth and Business plans. The store reminds shoppers in steps by email (when they opted in at checkout, guests included), by notification, and by SMS when they agreed to it.',
      aSoon:
        'Yes, on the Growth and Business plans. The store reminds shoppers in steps by notification, and by SMS when they agreed to it. Reminder emails are coming soon.',
    },
    {
      q: 'Is there loyalty and a referral programme?',
      a: 'Yes. Loyalty points, tiers and referral rewards are on Growth and Business, and the affiliate programme with commission is on Business.',
    },
    {
      q: 'Can I send email campaigns to newsletter subscribers?',
      needs: 'campaigns',
      a: 'Yes, on Growth and Business. Automatic order emails (confirmation, shipping, refunds, review request) work on every plan.',
      aSoon:
        'Automatic order emails (confirmation, shipping, refunds, review request) work on every plan. Email campaigns to subscribers are coming soon on Growth and Business.',
    },
    {
      q: 'Can I connect my store to other tools?',
      needs: 'webhooks',
      a: 'Yes, on Growth and Business. The store notifies the tool you choose when something happens, such as a new order.',
      aSoon:
        'This is coming soon on Growth and Business. There is no app marketplace, but you will be able to connect your store to your tools.',
    },
    {
      q: 'Are there order barcodes?',
      needs: 'barcodes',
      a: 'Yes. Every order has a barcode in 23 fun shapes, and a packing slip carries it, with bulk printing.',
      aSoon:
        'Coming soon: a barcode on every order in 23 fun shapes, and a packing slip that carries it, with bulk printing.',
    },
    {
      q: 'Can I sell wholesale to businesses?',
      needs: 'b2b',
      a: 'Yes, on the Business plan: prices that drop with quantity, customer groups, minimum orders, and your approval of a wholesale buyer.',
      aSoon:
        'Coming soon on the Business plan: prices that drop with quantity, customer groups, minimum orders, and your approval of a wholesale buyer. Until it ships there are no wholesale price lists.',
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
      a: 'There is no app marketplace, no custom code editor, no point-of-sale and no multi-currency store. The comparison pages for Salla, Zid and Shopify go through the details, and what is coming soon.',
    },
  ],
};

/** The FAQ for a locale, with each answer resolved against the registry (live vs coming). */
export function featuresFaq(locale: Locale): { q: string; a: string }[] {
  return FAQ_ITEMS[locale].map(i => ({
    q: i.q,
    a: i.needs && !isLive(i.needs) && i.aSoon ? i.aSoon : i.a,
  }));
}

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
