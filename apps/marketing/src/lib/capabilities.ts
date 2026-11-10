import type { Locale } from './site';
import {
  isLive,
  THEMES as THEME_LIST,
  type CapabilityId,
  type CardId,
  type ThemeId,
} from './capability-registry';

/**
 * What Ebda Store can do, for /features and the home capabilities section. Every entry is
 * backed by code (evidence paths in .superpowers/marketing-report.md); anything not provable
 * from the repo is left out. Plan notes follow the one plan catalogue (plans.ts /
 * packages/shared plan-limits + plan-baselines): custom domain is on every plan, cart recovery,
 * loyalty and the AI assistant start at Growth, multi-warehouse and affiliates are Business.
 *
 * ONE ITEM PER CAPABILITY: a capability appears once on the whole page. Search (Egyptian/Franco
 * understanding, AI search words, search insights) is one item; so are AI writing, the assistant and
 * cart recovery. tests/unit/marketing-capability-registry.test.tsx fails on a repeated title/concept.
 */
export interface CapabilityCopy {
  /** Short card title. */
  t: string;
  /** One to three full sentences. */
  d: string;
  /** Plan names, rendered after the "Available on" label. */
  plan?: string;
  /** A full sentence about plans/limits, rendered as is (no label in front of it). */
  note?: string;
  /** A part of this capability that is not live yet: its text, shown with the coming badge while `needs` is coming. */
  soon?: { needs: CapabilityId; text: string };
}

export type { CapabilityId, CardId } from './capability-registry';

export interface ThemeCopy {
  /** Plain h2 (no eyebrow). */
  title: string;
  /** One short line under the heading. */
  lead: string;
}

/** Order = order on /features: the AI theme first, with every AI capability exactly once. */
export const THEMES = THEME_LIST;

/** Every capability card on /features, in page order. */
export const CAPABILITY_IDS: readonly CardId[] = THEMES.flatMap(t => t.ids);

export const THEME_COPY: Record<Locale, Record<ThemeId, ThemeCopy>> = {
  ar: {
    ai: {
      title: 'ذكاء اصطناعي جوه كل حاجة، مش زرار على الجنب.',
      lead: 'ابدأ ستور بيشتغل جنبك في المتجر والبحث والحسابات والمخزون والأرقام. إنت اللي بتقرر، والذكاء الاصطناعي بيجهّز لك الشغل.',
    },
    store: {
      title: 'متجرك وشكله',
      lead: 'اختار شكل متجرك وظبّطه بنفسك، وابدأ بيع على لينك مجاني أو على دومينك.',
    },
    sell: {
      title: 'بيع وسوّق',
      lead: 'رجّع العميل اللي مشي، وكلّمه بعد الشراء، وكافئه عشان يرجع تاني.',
    },
    ops: {
      title: 'تشغيل المتجر',
      lead: 'دفع وشحن للسوق المصري، ومخازن وباركود، وأدوات تانية تربطها بمتجرك.',
    },
    pricing: {
      title: 'سعر من غير مفاجآت',
      lead: 'اشتراك واضح، ومفيش حاجة بتتاخد من طلباتك.',
    },
  },
  en: {
    ai: {
      title: 'AI inside everything, not a button on the side.',
      lead: 'Ebda Store works alongside you in your store, search, accounts, stock and numbers. You decide, and the AI prepares the work.',
    },
    store: {
      title: 'Your store and its design',
      lead: 'Pick how your store looks, tune it yourself, and sell from a free link or your own domain.',
    },
    sell: {
      title: 'Sell and market',
      lead: 'Win back shoppers who left, talk to them after they buy, and reward them for coming back.',
    },
    ops: {
      title: 'Run the store',
      lead: 'Payments and shipping for Egypt, warehouses and barcodes, and the other tools you connect.',
    },
    pricing: {
      title: 'Pricing with no surprises',
      lead: 'A clear subscription, and nothing taken from your orders.',
    },
  },
};

export const CAPABILITIES: Record<Locale, Record<CardId, CapabilityCopy>> = {
  ar: {
    ai: {
      t: 'كتابة وترجمة وتحسين بالذكاء الاصطناعي',
      d: 'بيكتب وصف المنتجات ويترجمها عربي وإنجليزي، ويجهّز عناوين وأوصاف لمحركات البحث، وأسئلة شائعة، وتصنيفات ووسوم (تاجات)، ونص بديل للصور، لمنتج واحد أو لمتجرك كله. إنت اللي بتراجع وتنشر.',
      note: 'مشمول في كل الباقات المدفوعة، في حدود الاستخدام العادل.',
    },
    search: {
      t: 'بحث بيفهم المصري والفرانكو',
      d: 'عميلك بيكتب زي ما بيتكلم: بالعامية المصرية، أو بالفرانكو زي "gazma" و"kotshy"، أو بالإنجليزي، والبحث بيفهم أشكال الحروف زي أ وا وه وة، وبيلاقي المنتج حتى لو الكتابة مش مظبوطة. كل منتج بياخد لوحده كلمات بحث بالمصري والفرانكو والإنجليزي وأشهر أخطاء الكتابة، وتقدر تعدّلها. وتشوف عملاءك بحثوا عن إيه، وإيه اللي مالقوش له نتيجة، عشان تضيف المنتج الناقص.',
      soon: {
        needs: 'meaning',
        text: 'بحث بالمعنى: العميل يكتب اللي في دماغه والبحث يفهم قصده. بنطرحه تدريجيًا، ومش بيتفعّل على متجرك غير لما نتأكد إن نتايجه ممتازة على منتجات حقيقية.',
      },
    },
    assistant: {
      t: 'شغّل متجرك من مساعد ذكاء اصطناعي',
      d: 'وصّل مساعدك المفضل بمتجرك، واطلب منه يضيف منتجات ويعدّل أسعار ويراجع الطلبات بدل ما تفتح لوحة التحكم.',
      plan: 'باقتَي النمو والأعمال',
    },
    accounting: {
      t: 'حساباتك بتخلص أسرع',
      d: 'صوّر إيصال المورّد وارفعه، فيتحوّل لمصروف مسودة جاهز تراجعه. ولما هامش الربح ينزل أو التكاليف تقفز أو الإيرادات تقع أو المرتجعات تزيد، بيجيلك تنبيه مع شرح بالعربي والإنجليزي.',
      note: 'قراءة إيصالات المورّدين في باقتَي النمو والأعمال.',
    },
    inventory: {
      t: 'مخزونك بيقولك تعمل إيه',
      d: 'اقتراحات إعادة الطلب: بيحسب سرعة بيع كل منتج وبيقولك إمتى تطلب وكام، ومعاه السبب. والمنتجات الراكدة بتتعلّم لوحدها ومعاها نص جاهز لعرض تصفية.',
      note: 'إيميل التنبيه لما منتج يقرب يخلص في باقتَي النمو والأعمال.',
    },
    analytics: {
      t: 'أرقام متجرك بتتشرح',
      d: 'اعرف إيه اللي بيتباع وإيراداتك، وسطرين بالعربي والإنجليزي فوق لوحة الأرقام بيشرحوا إيه اللي اتغيّر. والمنتجات اللي بتتباع مع بعض بتظهر للعميل في صفحة المنتج والسلة. مستوى التفاصيل بيزيد مع الباقة.',
    },
    instapay: {
      t: 'إيصال إنستاباي بيتقري لوحده',
      d: 'الإيصال اللي العميل بيرفعه بيتقري لوحده، فمحدش يضطر يكتب بيانات التحويل.',
    },
    seo: {
      t: 'SEO وظهور في إجابات الذكاء الاصطناعي',
      d: 'عناوين وأوصاف لمحركات البحث، وتحويلات للينكات القديمة، وأسئلة شائعة منظّمة. ومتجرك بيظهر لمساعدات الذكاء الاصطناعي: بنجهّزلهم تعريف بمتجرك وقائمة منتجات محدّثة دايمًا يقدروا يقروها. وكمان تقدر تتابع هل مساعدات الذكاء الاصطناعي بتذكر متجرك.',
    },
    builder: {
      t: 'قوالب وأشكال جاهزة ومحرر صفحات',
      d: 'اختار من 5 قوالب، وكل قالب بـ3 أشكال جاهزة، وبعدين عدّل الألوان والصور وترتيب الأقسام من محرر صفحات بتشوف فيه التغيير قدامك على طول، من غير مبرمج.',
    },
    domain: {
      t: 'لينك مجاني ودومين خاص بيك',
      d: 'كل متجر بيطلع على لينك مجاني بالشكل ده: yourname.ebda.app، وتقدر تربط دومينك الخاص من لوحة التحكم، وده متاح في كل الباقات.',
    },
    cart: {
      t: 'استرجاع السلات المتروكة',
      d: 'لو عميل ساب منتجات في السلة، المتجر بيفكّره على خطوات ويرجّعه للسلة بلينك مباشر، بإشعار أو بإيميل. والـSMS في باقة الأعمال، بحساب SMS خاص بيك. الإيميل والـSMS بيوصلوا بس لو العميل وافق وهو بيدفع، حتى لو زائر من غير حساب.',
      plan: 'باقتَي النمو والأعمال',
    },
    emails: {
      t: 'إيميلات الطلبات بتتبعت لوحدها',
      d: 'تأكيد الطلب، والشحن، والاسترجاع، ونجاح الدفع أو فشله، وطلب تقييم بعد الاستلام، كلها بتتبعت لعميلك بالعربي أو الإنجليزي بشكل متناسق مع شكل متجرك.',
    },
    campaigns: {
      t: 'حملات إيميل لمشتركيك',
      d: 'اكتب رسالة تسويقية بالعربي والإنجليزي وابعتها لمشتركي نشرتك اللي وافقوا على استلامها.',
      plan: 'باقتَي النمو والأعمال',
    },
    loyalty: {
      t: 'نقاط ولاء ومكافآت إحالة وعمولة مسوّقين',
      d: 'العميل بيكسب نقاط على كل جنيه بيصرفه، وعلى التسجيل والتقييم وعيد الميلاد والإحالة، وبيترقى بين أربع مستويات. وللمتاجر الكبيرة برنامج مسوّقين بعمولة بتحددها إنت.',
      note: 'النقاط في باقتَي النمو والأعمال، وبرنامج المسوّقين في باقة الأعمال.',
    },
    reviews: {
      t: 'تقييمات العملاء',
      d: 'العميل بيقيّم المنتج بعد ما يستلمه، وإنت بتراجع التقييمات قبل ما تظهر في المتجر.',
    },
    payments: {
      t: 'دفع وشحن زي ما السوق المصري متعود',
      d: 'الدفع عند الاستلام، وإنستاباي، والكارت والمحفظة عن طريق Paymob وKashier وFawryPay. والشحن مع بوسطة وShipBlu ومايلرز وأرامكس، أو توصّل بنفسك.',
    },
    warehouse: {
      t: 'أكتر من مخزن وأوامر شراء',
      d: 'لو عندك أكتر من مخزن، تابع المخزون في كل واحد، واعمل أوامر شراء من الموردين، وامسح باركود المنتجات.',
      plan: 'باقة الأعمال',
    },
    barcodes: {
      t: 'باركود للطلبات وبوليصة تغليف',
      d: 'كل طلب ليه باركود تمسحه فيفتح الطلب على طول، وبييجي في 23 شكل مميز. وفيه بوليصة تغليف عليها الباركود وطباعة بالجملة.',
    },
    b2b: {
      t: 'بيع بالجملة (B2B)',
      d: 'أسعار بتقل مع زيادة الكمية، ومجموعات عملاء، وحد أدنى للطلب، وموافقة منك على تاجر الجملة قبل ما يشتري.',
      plan: 'باقة الأعمال',
    },
    webhooks: {
      t: 'اربط متجرك بأدواتك التانية',
      d: 'لما يحصل حاجة في متجرك زي طلب جديد، المتجر بيبعت إشعار للأداة اللي تحددها، فتقدر توصّله بنظام المحاسبة أو الشحن أو أي أداة بتشتغل بيها.',
      plan: 'باقتَي النمو والأعمال',
    },
    commission: {
      t: 'صفر عمولة على طلباتك',
      d: 'بتدفع الاشتراك بس، من غير عمولة على أي طلب في أي باقة. رسوم بوابة الدفع بتتحسب منفصلة لو العميل دفع أونلاين.',
    },
  },
  en: {
    ai: {
      t: 'AI that writes, translates and optimises',
      d: 'It writes product descriptions and translates them between Arabic and English, and drafts search-engine titles and descriptions, FAQs, categories, tags and image alt text, for one product or your whole store. You review and publish.',
      note: 'Included in every paid plan, within fair-use limits.',
    },
    search: {
      t: 'Search that understands Egyptian Arabic and Franco',
      d: 'Your shoppers type the way they talk: in Egyptian Arabic, in Franco like "gazma" or "kotshy", or in English. Search understands letter variants such as أ/ا and ه/ة, and still finds the product when the spelling is not exact. Every product gets its own search words in Egyptian Arabic, Franco and English plus the common misspellings, and you can edit them. You also see what shoppers searched for and found nothing, so you can add the missing product.',
      soon: {
        needs: 'meaning',
        text: 'Search by meaning: shoppers type what they have in mind and search understands what they mean. We are rolling it out gradually, and it only switches on for your store once its results pass our quality check on a real catalogue.',
      },
    },
    assistant: {
      t: 'Run your store from an AI assistant',
      d: 'Connect your favourite assistant to your store and ask it to add products, change prices and review orders instead of opening the dashboard.',
      plan: 'Growth and Business plans',
    },
    accounting: {
      t: 'Your books close faster',
      d: 'Snap a photo of a supplier receipt and upload it, and it becomes a draft expense for you to review. When your margin drops, costs jump, revenue falls or refunds rise, you get an alert explained in Arabic and English.',
      note: 'Receipt reading is on the Growth and Business plans.',
    },
    inventory: {
      t: 'Your stock tells you what to do',
      d: 'Reorder suggestions: it works out how fast each product sells and tells you when to reorder and how much, with the reason. Slow-moving products are flagged on their own, with ready-made clearance copy.',
      note: 'The low-stock warning email is on the Growth and Business plans.',
    },
    analytics: {
      t: 'Your numbers explain themselves',
      d: 'See what sells and your revenue, with two lines in Arabic and English above your numbers explaining what changed. Products that sell together show up for shoppers on the product page and in the cart. The level of detail grows with the plan.',
    },
    instapay: {
      t: 'InstaPay receipts read themselves',
      d: 'The receipt a customer uploads is read automatically, so nobody types the transfer details.',
    },
    seo: {
      t: 'SEO and visibility in AI answers',
      d: 'Search-engine titles and descriptions, redirects for old links and structured FAQs. Your store also shows up for AI assistants: we prepare an always-current store profile (llms.txt) and product feed they can read. You can also track whether AI assistants mention your store.',
    },
    builder: {
      t: 'Templates, ready-made looks and a page builder',
      d: 'Pick from five templates with three ready-made looks each, then change colours, photos and the order of sections in a page builder where you see every change as you make it. No developer needed.',
    },
    domain: {
      t: 'A free address and your own domain',
      d: 'Every store gets a free yourname.ebda.app address, and you can connect your own domain from the dashboard. A custom domain is available on every plan.',
    },
    cart: {
      t: 'Abandoned-cart recovery',
      d: 'When a shopper leaves items in the cart, the store reminds them in steps and sends them back to the cart with a direct link, by notification or by email. SMS is on the Business plan, through your own SMS account. Email and SMS only go out when the shopper agreed at checkout, guests included.',
      plan: 'Growth and Business plans',
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
    loyalty: {
      t: 'Loyalty points, referral rewards and affiliates',
      d: 'Customers earn points on every pound they spend and for signing up, reviewing, birthdays and referrals, and move up through four tiers. Larger stores can also run an affiliate programme with a commission you set.',
      note: 'Points are on Growth and Business, the affiliate programme on Business.',
    },
    reviews: {
      t: 'Customer reviews',
      d: 'Customers review a product after it arrives, and you moderate reviews before they appear on your store.',
    },
    payments: {
      t: 'Payments and shipping the Egyptian market expects',
      d: 'Cash on delivery, InstaPay, and card and wallet payments through Paymob, Kashier and FawryPay. Shipping with Bosta, ShipBlu, Mylerz and Aramex, or deliver yourself.',
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
    webhooks: {
      t: 'Connect your store to your other tools',
      d: 'When something happens in your store, such as a new order, it notifies the tool you choose, so you can connect it to your accounting, shipping or any other tool you work with.',
      plan: 'Growth and Business plans',
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
      a: 'أيوه. فيه 5 قوالب، وكل قالب بـ3 أشكال جاهزة، وتقدر تعدّل الألوان والصور والأقسام من محرر الصفحات.',
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
      needs: 'cart',
      a: 'أيوه، في باقتَي النمو والأعمال. المتجر بيفكّر العميل على خطوات بالإيميل (لو وافق وهو بيدفع، حتى كزائر)، وبإشعار. والـSMS في باقة الأعمال، بحساب SMS خاص بيك، ولو العميل وافق عليها.',
      aSoon:
        'أيوه، في باقتَي النمو والأعمال. المتجر بيفكّر العميل على خطوات بإشعار. والـSMS في باقة الأعمال، بحساب SMS خاص بيك، ولو العميل وافق عليها. والتذكير بالإيميل جاي قريبًا.',
    },
    {
      q: 'فيه نقاط ولاء وبرنامج إحالة؟',
      a: 'أيوه. نقاط الولاء والمستويات ومكافآت الإحالة في باقتَي النمو والأعمال، وبرنامج المسوّقين بالعمولة في باقة الأعمال.',
    },
    {
      q: 'فيه حملات إيميل لمشتركي النشرة؟',
      needs: 'campaigns',
      a: 'أيوه، في باقتَي النمو والأعمال. إيميلات الطلبات (تأكيد وشحن واسترجاع وطلب تقييم) شغالة في كل الباقات.',
      aSoon:
        'إيميلات الطلبات (تأكيد وشحن واسترجاع وطلب تقييم) شغالة في كل الباقات. وحملات الإيميل للمشتركين جاية قريبًا في باقتَي النمو والأعمال.',
    },
    {
      q: 'أقدر أربط متجري بأدوات تانية؟',
      needs: 'webhooks',
      a: 'أيوه، في باقتَي النمو والأعمال. المتجر بيبعت إشعار للأداة اللي تحددها لما يحصل حاجة زي طلب جديد.',
      aSoon:
        'ده جاي قريبًا في باقتَي النمو والأعمال. مفيش متجر تطبيقات، لكن هتقدر توصّل متجرك بأدواتك.',
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
      needs: 'cart',
      a: 'Yes, on the Growth and Business plans. The store reminds shoppers in steps by email (when they opted in at checkout, guests included), by notification. SMS is on the Business plan, through your own SMS account, when the shopper agreed to it.',
      aSoon:
        'Yes, on the Growth and Business plans. The store reminds shoppers in steps by notification. SMS is on the Business plan, through your own SMS account, when the shopper agreed to it. Reminder emails are coming soon.',
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
      a: 'There is no app marketplace, no custom code editor, no point-of-sale and no multi-currency store. The comparison pages for Zid and Shopify go through the details, and what is coming soon.',
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
  }
> = {
  ar: {
    title: 'مميزات ابدأ ستور',
    desc: 'قوالب ومحرر صفحات، دومين خاص، ذكاء اصطناعي، بحث بالعامية والفرانكو، SEO، استرجاع سلات، نقاط ولاء، تقييمات، تحليلات، ودفع وشحن للسوق المصري. صفر عمولة.',
    h1: 'كل اللي ابدأ ستور بيعمله.',
    lead: 'ده اللي موجود فعلًا النهاردة في ابدأ ستور من ابدأ ستوديو للذكاء الاصطناعي. وكل حاجة لسه مش موجودة مكتوبة بصراحة في صفحات المقارنة.',
    planLabel: 'متاح في',
    faqTitle: 'أسئلة عن المميزات',
    compareTitle: 'قارن ابدأ ستور بغيره',
    cta: 'افتح متجرك',
    homeTitle: 'مش متجر بسيط وبس.',
    homeLead:
      'ده غير الدفع والشحن والسلات المتروكة ونقاط الولاء. كله في باقة واحدة وبصفر عمولة، وتفاصيل الباقات في اللي بعده.',
    homeAll: 'شوف كل المميزات',
  },
  en: {
    title: 'Ebda Store features',
    desc: 'Templates, page builder, custom domain, AI tools, Egyptian Arabic search, SEO, cart recovery, loyalty, reviews, analytics, payments and shipping. 0% commission.',
    h1: 'Everything Ebda Store does.',
    lead: 'This is what exists in Ebda Store today, from Ebda AI Studio. What is not there yet is listed honestly on the comparison pages.',
    planLabel: 'Available on',
    faqTitle: 'Questions about features',
    compareTitle: 'Compare Ebda Store',
    cta: 'Open your store',
    homeTitle: 'More than a simple store.',
    homeLead:
      'On top of payments and shipping, cart recovery and loyalty points. All of it in one plan, at 0% commission; the plans come next.',
    homeAll: 'See all features',
  },
};
