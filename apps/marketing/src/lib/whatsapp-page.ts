import { BRAND, WHATSAPP_YEARLY_MONTHS_PAID, type WhatsAppBasePackageId } from '@ebda/shared/brand';
import { PLANS } from './plans';
import type { Locale } from './site';

/**
 * Copy of the Ebda Chat product page (/whatsapp, /en/whatsapp). Every fact here is taken from the Ebda Chat
 * repo (docs/help, docs/site, docs/billing.md) or the program register; nothing is invented. Package prices, seats
 * and AI credits are NOT typed here: the pricing section reads WHATSAPP_PACKAGES (Ruling WA-PRICE-1), and the copy
 * below only supplies labels.
 */
export interface WhatsAppPage {
  meta: { title: string; desc: string };
  h1: string;
  lead: string;
  ctaStart: string;
  /** Alt text and caption of the Ebda Chat art (Ruling MKT-CHAT-ART-1): /chat/chat-{hero,inbox,campaign}-{ar,en}.svg. */
  art: { hero: string; inbox: string; campaign: string; caption: string };
  featuresH: string;
  features: { t: string; p: string }[];
  storeH: string;
  storeLead: string;
  storePoints: string[];
  numbersH: string;
  numbersLead: string;
  table: { cols: [string, string, string]; rows: [string, string, string][] };
  /** The packages section: every number comes from WHATSAPP_PACKAGES, never from these strings (WA-PRICE-1). */
  pricing: WhatsAppPricingCopy;
  feesH: string;
  fees: string[];
  accountH: string;
  account: string;
  faqH: string;
  faq: { q: string; a: string }[];
  closeH: string;
  closeP: string;
  helpLink: string;
  /** The modest cross-link on the home page and /features. */
  teaser: { h: string; p: string; cta: string };
}

const AR = BRAND.productWhatsapp.nameAr;
const EN = BRAND.productWhatsapp.nameEn;
const STORE_AR = BRAND.product.nameAr;
const STORE_EN = BRAND.product.nameEn;
const STUDIO_AR = BRAND.company.shortNameAr;
const STUDIO_EN = BRAND.company.shortNameEn;
/** The plan that carries the Ebda Chat Store package (WA-PKG-1), named from the plan catalogue. */
const BIZ = PLANS.find(p => p.id === 'business')!.name;

export interface WhatsAppPricingCopy {
  title: string;
  lead: string;
  perMonth: string;
  perYear: string;
  monthly: string;
  yearly: string;
  intervalLabel: string;
  pickLabel: string;
  /** The yearly saving, as a percent derived from the months paid for twelve. */
  saveNote: (percent: number) => string;
  /** Under the cards: Meta's fees are separate. */
  metaNote: string;
  names: Record<WhatsAppBasePackageId, { name: string; short: string; tag: string }>;
  /** Plan card CTA; {plan} is the plan name. */
  cta: string;
  /** The store-included card: no price figure, only this line (there is no free plan). */
  includedLabel: string;
  ctaIncluded: string;
  members: (n: number) => string;
  aiCredits: (n: number) => string;
  features: {
    shared_inbox: string;
    order_confirmations: string;
    templates: string;
    campaigns: string;
    order_in_chat: string;
    api: string;
    priority_support: string;
  };
}

export const WHATSAPP_PAGE: Record<Locale, WhatsAppPage> = {
  ar: {
    meta: {
      title: `${AR}: بيع ورد على عملائك على واتساب`,
      desc: `${AR} من ${STUDIO_AR}: صندوق وارد مشترك، وتأكيد طلبات ودفع عند الاستلام مربوط بمتجرك، وحملات بموافقة العميل، ومساعد ذكي بيرد بالمصري.`,
    },
    h1: `${AR} — بيع ورد على عملائك على واتساب`,
    lead: `أكّد الطلبات وابعت الحملات لعملائك على واتساب من مكان واحد، ومربوط بمتجرك على ${STORE_AR}. بيشتغل على منصة واتساب للأعمال الرسمية من Meta.`,
    art: {
      hero: 'محادثة على واتساب بين متجر وعميل: رسالة تأكيد طلب دفع عند الاستلام، ورد العميل، وتأكيد الطلب',
      inbox: 'الصندوق المشترك: قايمة محادثات العملاء مع تاجز ورسايل جديدة وتوزيع على فريقك',
      campaign:
        'إرسال حملة: قالب معتمد، وشريحة عملاء وافقوا على العروض، والتكلفة المتوقعة قبل التأكيد',
      caption: 'مثال توضيحي',
    },
    ctaStart: 'ابدأ دلوقتي',
    featuresH: 'اللي هتلاقيه جوّه',
    features: [
      {
        t: 'صندوق وارد مشترك',
        p: 'كل محادثات العملاء في شاشة واحدة. وزّع المحادثة على حد من فريقك، وحط عليها تاجز وملاحظات خاصة، وادوّر في الرسايل.',
      },
      {
        t: 'تأكيد الطلبات والدفع عند الاستلام',
        p: `أول ما العميل يعمل طلب دفع عند الاستلام، بيوصله على واتساب زرّين: تأكيد الطلب أو رفضه. النتيجة بترجع لمتجرك، وتأكيد الطلب وتحديثات الشحن بتتبعت من بيانات ${STORE_AR}. لو العميل ما ردّش في 24 ساعة بتتسجّل «مفيش رد».`,
      },
      {
        t: 'اطلب من جوّه الشات',
        p: 'العميل يختار منتجات من الكتالوج على واتساب ويبعت السلة، ويدفع بإنستاباي، والطلب بيفضل «في انتظار الدفع» لحد ما متجرك يتأكد إن الفلوس وصلت.',
      },
      {
        t: 'قوالب وحملات بموافقة العميل',
        p: 'ابعت قالب معتمد من Meta لشريحة من عملائك، وشوف التكلفة المتوقعة قبل ما تأكّد، وجدول الحملة لوقت تختاره. بتتبعت بس للعملاء اللي وافقوا على التسويق، واللي رفض أو معندوش موافقة مسجّلة بيتشال لوحده.',
      },
      {
        t: 'مساعد ذكي بيرد بالمصري',
        p: 'بيرد على عملائك من المعلومات اللي إنت كاتبها عن متجرك، ويدوّر في الكتالوج، ويقول حالة الطلب، ويسلّم المحادثة لفريقك لما العميل يطلب حد. بيرد جوه نافذة الـ 24 ساعة بس، وكل رد بيستهلك من رصيد الذكاء الاصطناعي.',
      },
      {
        t: 'قايمة أسئلة ومواعيد وموقع',
        p: 'اعمل قايمة بأسئلتك الشائعة (لحد 8 أسئلة)، ورد تلقائي وقت ما تكون مقفول، ولوكيشن متجرك بلمسة واحدة.',
      },
    ],
    storeH: `مربوط بـ ${STORE_AR}`,
    storeLead: `الربط جاهز من غير إعداد منك. ${STORE_AR} هو اللي بيمسك الطلبات والأسعار والمخزون، و${AR} بيحكي مع العميل بالبيانات دي.`,
    storePoints: [
      'تأكيد الطلب وتحديثات الشحن بتوصل العميل على واتساب.',
      'نتيجة تأكيد الدفع عند الاستلام (أكّد، رفض، مفيش رد) بترجع لمتجرك.',
      'الكتالوج والطلبات من جوّه الشات بتيجي من متجرك، من غير ما تكتبها مرتين.',
    ],
    numbersH: 'رقمك إنت أو الرقم المشترك',
    numbersLead:
      'تقدر توصّل رقم الأعمال بتاعك، أو تبدأ بسرعة على الرقم المشترك. لو بتستخدم تطبيق واتساب للأعمال على نفس الرقم، تقدر تفضل تستخدمه جنب التطبيق من غير ما تخسر حاجة.',
    table: {
      cols: ['البند', 'رقمك الخاص', 'الرقم المشترك'],
      rows: [
        ['اللي العميل بيشوفه', 'اسم نشاطك ورقمك', 'رقم المنصة، والعميل بيختار متجرك من قايمة'],
        ['الإعداد', 'ربط من خلال خطوات Meta الرسمية', 'انضمام من جوّه التطبيق'],
        ['الحملات التسويقية', 'أيوه', 'لأ'],
        ['مين بيدفع لـ Meta', 'Meta بتحاسب كارتك إنت مباشرةً', 'المحفظة، بسعر Meta'],
      ],
    },
    pricing: {
      title: 'باقة على قد شغلك.',
      lead: 'اختار الباقة اللي تناسب فريقك وعدد ردود الذكاء الاصطناعي اللي محتاجها.',
      perMonth: 'في الشهر',
      perYear: 'في السنة',
      monthly: 'شهري',
      yearly: 'سنوي',
      intervalLabel: 'مدة الدفع',
      pickLabel: 'اختار الباقة',
      saveNote: pct => `وفّر ${pct}% لو دفعت سنوي.`,
      metaNote:
        'رسوم رسايل Meta منفصلة: على رقمك الخاص Meta بتحاسب كارتك إنت، وعلى الرقم المشترك بتتخصم من محفظة مدفوعة مقدمًا، وبدون هامش مننا حاليًا (0%).',
      names: {
        'store-included': {
          name: 'مضمّنة',
          short: 'مضمّنة',
          tag: `لتجّار ${STORE_AR}`,
        },
        starter: { name: 'المبتدئة', short: 'المبتدئة', tag: 'لأول فريق' },
        growth: { name: 'النمو', short: 'النمو', tag: 'حملات وطلبات جوّه الشات' },
        pro: { name: 'الاحترافية', short: 'الاحترافية', tag: 'ربط برمجي ودعم بالأولوية' },
      },
      cta: 'ابدأ بباقة {plan}',
      includedLabel: `مضمّنة مع ${STORE_AR} ${BIZ.ar}`,
      ctaIncluded: `شوف أسعار ${STORE_AR}`,
      members: n => (n === 2 ? 'عضوين في الفريق' : `${n} ${n <= 10 ? 'أعضاء' : 'عضو'} في الفريق`),
      aiCredits: n => `${n.toLocaleString('en-US')} رد بالذكاء الاصطناعي في الشهر`,
      features: {
        shared_inbox: 'صندوق وارد مشترك',
        order_confirmations: 'تأكيد الطلبات والدفع عند الاستلام',
        templates: 'قوالب رسايل',
        campaigns: 'حملات بموافقة العميل',
        order_in_chat: 'اطلب من جوّه الشات',
        api: 'ربط برمجي (API)',
        priority_support: 'دعم بالأولوية',
      },
    },
    feesH: 'رسوم Meta',
    fees: [
      'Meta بتحاسب على الرسايل حسب نوعها (تسويق، معاملات، مصادقة، خدمة). على رقمك الخاص بتحاسب كارتك إنت مباشرةً. على الرقم المشترك بتتخصم من محفظة بالجنيه بتشحنها، بنفس سعر Meta.',
    ],
    accountH: 'حساب واحد',
    account: `بتدخل ${AR} بنفس حساب ${STUDIO_AR} اللي بتدخل بيه ${STORE_AR}، من غير حساب تاني ولا باسورد تاني.`,
    faqH: 'أسئلة شائعة',
    faq: [
      {
        q: 'محتاج رقم جديد؟',
        a: 'لأ. تقدر توصّل رقمك الحالي (ويفضل يكون حساب Meta للأعمال بتاعك متوثّق)، أو تبدأ على الرقم المشترك من غير توثيق ولا ربط.',
      },
      {
        q: 'مين بيدفع رسوم Meta؟',
        a: 'على رقمك الخاص: Meta بتحاسب كارتك إنت مباشرةً. على الرقم المشترك: المحفظة بسعر Meta، بدون هامش من عندنا حاليًا.',
      },
      {
        q: 'أقدر أبعث لأي حد؟',
        a: 'التسويق بيتبعت بس للعملاء اللي وافقوا عليه، وبقالب معتمد من Meta. اللي بيبعت STOP بيتشال من الحملات. والرد الحر على العميل بيكون جوه 24 ساعة من آخر رسالة منه.',
      },
      {
        q: `هل ${AR} تبع واتساب؟`,
        a: `لأ، ${AR} منتج من ${STUDIO_AR}، وبيشتغل على منصة واتساب للأعمال الرسمية من Meta.`,
      },
      {
        q: 'المساعد الذكي بيرد إمتى؟',
        a: 'جوه نافذة الـ 24 ساعة بس. لما رصيد الذكاء الاصطناعي يخلص، أو العميل يطلب حد، أو المساعد ميعرفش يرد، بيسلّم المحادثة لفريقك.',
      },
    ],
    closeH: `جاهز تكلّم عملاءك على واتساب؟`,
    closeP: `سجّل بحساب ${STUDIO_AR} وابدأ.`,
    helpLink: 'شوف خطوات الإعداد في مركز المساعدة',
    teaser: {
      h: AR,
      p: `عملاؤك بيكلّموك على واتساب؟ ${AR} بيجمّع المحادثات والطلبات وتأكيد الدفع عند الاستلام في مكان واحد، ومربوط بمتجرك.`,
      cta: `تعرّف على ${AR}`,
    },
  },
  en: {
    meta: {
      title: `${EN}: sell and support your customers on WhatsApp`,
      desc: `${EN} by ${STUDIO_EN}: a shared inbox, order and COD confirmations linked to ${STORE_EN}, consent-based campaigns and an AI agent in Egyptian Arabic.`,
    },
    h1: `${EN} — sell and support your customers on WhatsApp`,
    lead: `Confirm orders and send campaigns to your customers on WhatsApp, all in one place, linked to ${STORE_EN}. Works with the WhatsApp Business Platform.`,
    art: {
      hero: 'A WhatsApp conversation between a store and a customer: a cash-on-delivery order confirmation message, the customer reply, and the confirmed order',
      inbox:
        'Shared inbox: a list of customer conversations with tags, new messages and assignment to your team',
      campaign:
        'Sending a campaign: an approved template, a segment of customers who agreed to offers, and the estimated cost before confirming',
      caption: 'Illustrative example',
    },
    ctaStart: 'Start now',
    featuresH: "What's inside",
    features: [
      {
        t: 'Shared inbox',
        p: 'Every customer conversation on one screen. Assign a conversation to a teammate, add tags and private notes, and search the messages.',
      },
      {
        t: 'Order and cash-on-delivery confirmations',
        p: `When a customer places a cash-on-delivery order, they get a WhatsApp message with two buttons: confirm the order or refuse it. The result goes back to your store, and order confirmations and shipping updates are sent from ${STORE_EN} data. If the customer does not answer within 24 hours, it is recorded as "no reply".`,
      },
      {
        t: 'Order inside the chat',
        p: 'A customer picks products from the catalog on WhatsApp, sends the cart, and pays with InstaPay. The order stays "awaiting payment" until your store confirms the money arrived.',
      },
      {
        t: 'Templates and campaigns with consent',
        p: 'Send a Meta-approved template to a segment of your customers, see the estimated cost before you confirm, and schedule the send. It goes only to customers who agreed to marketing; anyone who opted out, or has no consent on record, is removed automatically.',
      },
      {
        t: 'An AI agent that answers in Egyptian Arabic',
        p: 'It answers from the store knowledge you write, searches the catalog, reports order status, and hands the conversation to your team when the customer asks for a person. It replies only inside the 24-hour window, and every reply uses AI credits.',
      },
      {
        t: 'Service menu, hours and location',
        p: 'Add a menu of your common questions (up to 8), an automatic reply while you are closed, and your store location on a tap.',
      },
    ],
    storeH: `Linked to ${STORE_EN}`,
    storeLead: `The link is built in, with no setup on your side. ${STORE_EN} keeps owning orders, prices and stock; ${EN} talks to the customer using that data.`,
    storePoints: [
      'Order confirmations and shipping updates reach the customer on WhatsApp.',
      'The cash-on-delivery result (confirmed, refused, no reply) goes back to your store.',
      'The catalog and the orders placed in the chat come from your store, so you never type them twice.',
    ],
    numbersH: 'Your own number or the shared number',
    numbersLead:
      'Connect your own business number, or start quickly on the shared number. If you already use the WhatsApp Business app on that number, you can keep using it next to Ebda Chat without losing anything.',
    table: {
      cols: ['Item', 'Your own number', 'Shared number'],
      rows: [
        [
          'What customers see',
          'Your business name and number',
          "The platform's number; the customer picks your store from a list",
        ],
        ['Setup', "Connect through Meta's official flow", 'Join from the app'],
        ['Marketing campaigns', 'Yes', 'No'],
        ['Who pays Meta', 'Meta bills your own card directly', 'The wallet, at Meta’s price'],
      ],
    },
    pricing: {
      title: 'A package that fits your work.',
      lead: 'Pick the package that fits your team and the number of AI replies you need.',
      perMonth: 'a month',
      perYear: 'a year',
      monthly: 'Monthly',
      yearly: 'Yearly',
      intervalLabel: 'Billing period',
      pickLabel: 'Choose a package',
      saveNote: pct => `Save ${pct}% when you pay yearly.`,
      metaNote:
        "Meta's message fees are separate: on your own number Meta bills your card; on the shared number they come from a prepaid wallet with 0% margin from us at the moment.",
      names: {
        'store-included': {
          name: 'Included',
          short: 'Included',
          tag: `For ${STORE_EN} merchants`,
        },
        starter: { name: 'Starter', short: 'Starter', tag: 'For a first team' },
        growth: { name: 'Growth', short: 'Growth', tag: 'Campaigns and ordering in the chat' },
        pro: {
          name: 'Professional',
          short: 'Professional',
          tag: 'Integrations and priority support',
        },
      },
      cta: 'Start with {plan}',
      includedLabel: `Included with ${STORE_EN} ${BIZ.en}`,
      ctaIncluded: `See ${STORE_EN} pricing`,
      members: n => `${n} team members`,
      aiCredits: n => `${n.toLocaleString('en-US')} AI replies a month`,
      features: {
        shared_inbox: 'Shared inbox',
        order_confirmations: 'Order and cash-on-delivery confirmations',
        templates: 'Message templates',
        campaigns: 'Opt-in campaigns',
        order_in_chat: 'Ordering inside the chat',
        api: 'Integrations and API',
        priority_support: 'Priority support',
      },
    },
    feesH: "Meta's fees",
    fees: [
      "Meta charges per message by category (marketing, utility, authentication, service). On your own number, Meta bills your card directly. On the shared number the charge comes out of a prepaid EGP wallet you top up, at Meta's price.",
    ],
    accountH: 'One account',
    account: `You sign in to ${EN} with the same ${STUDIO_EN} account you use for ${STORE_EN}, with no second account and no second password.`,
    faqH: 'Questions',
    faq: [
      {
        q: 'Do I need a new number?',
        a: 'No. You can connect your current number (your Meta business account should preferably be verified), or start on the shared number with no verification and no connection.',
      },
      {
        q: "Who pays Meta's fees?",
        a: "On your own number, Meta bills your card directly. On the shared number, the wallet pays at Meta's price, with no margin from us at the moment.",
      },
      {
        q: 'Can I message anyone?',
        a: 'Marketing goes only to customers who agreed to it, using a Meta-approved template. Anyone who sends STOP is removed from campaigns. A free-text reply to a customer is allowed within 24 hours of their last message.',
      },
      {
        q: `Is ${EN} part of WhatsApp?`,
        a: `No. ${EN} is a product of ${STUDIO_EN}, built on Meta's official WhatsApp Business Platform.`,
      },
      {
        q: 'When does the AI agent answer?',
        a: 'Only inside the 24-hour window. When AI credits run out, the customer asks for a person, or the agent cannot answer, it hands the conversation to your team.',
      },
    ],
    closeH: 'Ready to talk to your customers on WhatsApp?',
    closeP: `Sign up with your ${STUDIO_EN} account and start.`,
    helpLink: 'See the setup guides in the help centre',
    teaser: {
      h: EN,
      p: `Do your customers message you on WhatsApp? ${EN} gathers the conversations, the orders and the cash-on-delivery confirmations in one place, linked to your store.`,
      cta: `Meet ${EN}`,
    },
  },
};

/** The WhatsApp app (LAUNCH-SUITE-1). */
/** The yearly saving in percent (9 months paid for 12 = 25%). */
export const WHATSAPP_YEARLY_SAVING_PCT = Math.round((1 - WHATSAPP_YEARLY_MONTHS_PAID / 12) * 100);

export const WHATSAPP_APP_URL = `https://${BRAND.domains.whatsappApp}`;
