import { BRAND } from '@ebda/shared/brand';
import type { Locale } from './site';

/**
 * Copy of the Ebda AI Studio home (`/`, `/en`), Ruling MKT-HOME-1. Product names and blurbs come from BRAND and the nav copy;
 * only the studio-level sentences live here. Only products that are live are listed (BRAND-ARCH-1): no CRM / ERP until they ship.
 */
export interface StudioHome {
  meta: { title: string; desc: string };
  eyebrow: string;
  h1: string;
  lead: string;
  productsH: string;
  store: { blurb: string; cta: string; more: string };
  chat: { blurb: string; cta: string; more: string };
  account: string;
  /** Living-geometry hero (Ruling MKT-STUDIO-C-1): the windows cut into the pattern. */
  windows: { storeFamily: string; chatFamily: string };
  /** What the studio does: one statement and three lines (the three fields of the legal name). */
  does: {
    label: string;
    statement: string;
    items: { h: string; p: string }[];
  };
  /** The products, one row each with three short facts. */
  products: { label: string; storeFacts: string[]; chatFacts: string[] };
  /** The order is real here (account, then product, then selling), so these are numbered. */
  steps: { label: string; h: string; items: { h: string; p: string }[] };
  trust: {
    label: string;
    h: string;
    items: { h: string; p: string }[];
    contactCta: string;
    legalLabel: string;
  };
}

const STUDIO_AR = BRAND.company.shortNameAr;
const STUDIO_EN = BRAND.company.shortNameEn;
const STORE_AR = BRAND.product.nameAr;
const STORE_EN = BRAND.product.nameEn;
const CHAT_AR = BRAND.productWhatsapp.nameAr;
const CHAT_EN = BRAND.productWhatsapp.nameEn;

export const STUDIO_HOME: Record<Locale, StudioHome> = {
  ar: {
    meta: {
      title: `${STUDIO_AR}: ${STORE_AR} و${CHAT_AR}`,
      desc: `${STUDIO_AR} بيعمل برامج للتجار في مصر: ${STORE_AR} لمتجرك على الإنترنت، و${CHAT_AR} لعملائك على واتساب. حساب واحد للاتنين.`,
    },
    eyebrow: STUDIO_AR,
    h1: 'متجرك وعملاؤك في مكان واحد.',
    lead: `${STORE_AR} بيفتحلك متجر على الإنترنت، و${CHAT_AR} بيكلّم عملاءك على واتساب. بتدخل للاتنين بنفس الحساب.`,
    productsH: 'منتجاتنا',
    store: {
      blurb: 'متجرك على الإنترنت في دقايق، بالعربي وبشكل يشبهك.',
      cta: 'افتح متجرك',
      more: `اعرف أكتر عن ${STORE_AR}`,
    },
    chat: {
      blurb: 'بيع ورد على عملائك على واتساب من مكان واحد.',
      cta: `ابدأ مع ${CHAT_AR}`,
      more: `اعرف أكتر عن ${CHAT_AR}`,
    },
    account: 'حساب واحد للاتنين، من غير باسورد تاني.',
    windows: { storeFamily: 'نجمة ثمانية', chatFamily: 'نجمة سداسية' },
    does: {
      label: 'اللي بنعمله',
      statement: 'بنبني برامج بتشتغل بالذكاء الاصطناعي، علشان التاجر المصري يبيع أكتر ويتعب أقل.',
      items: [
        { h: 'ذكاء اصطناعي', p: 'مساعد بيكتب وبيرد وبيرتّب معاك، من غير ما تحتاج تفهم تقنية.' },
        { h: 'برمجيات', p: 'متجر وشات جاهزين بالعربي، بيشتغلوا على الموبايل قبل الكمبيوتر.' },
        { h: 'تسويق رقمي', p: 'أدوات تجيبلك العميل وترجّعه، وأرقام واضحة تعرف منها إيه اللي نفع.' },
      ],
    },
    products: {
      label: 'منتجاتنا',
      storeFacts: [
        'قوالب جاهزة بالعربي',
        'دفع وشحن من مكان واحد',
        'ذكاء اصطناعي جوه المتجر بيساعدك في شغلك',
      ],
      chatFacts: [
        'صندوق واحد لكل رسايل واتساب',
        'رد سريع وحملات لعملائك',
        'مربوط بمتجرك بنفس الحساب',
      ],
    },
    steps: {
      label: 'إزاي تبدأ',
      h: 'تلات خطوات وتبدأ.',
      items: [
        { h: 'اعمل حسابك', p: 'بإيميلك بس، وبنفس الحساب تدخل على المنتجين.' },
        { h: 'اختار منتجك وظبّطه', p: 'متجر بشكل يشبهك، أو شات مربوط برقم واتساب نشاطك.' },
        { h: 'ابدأ بيع وردّ على عملائك', p: 'وأي سؤال في الطريق، فريقنا بيرد عليك بالعربي.' },
      ],
    },
    trust: {
      label: 'ثقة وتواصل',
      h: 'شركة مصرية، وبتتكلم معاك بالعربي.',
      items: [
        { h: 'حساب واحد', p: 'بتدخل على ابدأ ستور وابدأ شات بنفس الحساب.' },
        {
          h: 'سياسات مكتوبة',
          p: 'الشروط والخصوصية والاسترجاع موجودة ومفهومة، من غير بنود مستخبية.',
        },
        { h: 'حد بيرد عليك', p: 'إيميل وواتساب ومركز مساعدة، وبنرد على أسئلتك قبل ما تبدأ.' },
      ],
      contactCta: 'كلّمنا',
      legalLabel: 'الشروط والخصوصية',
    },
  },
  en: {
    meta: {
      title: `${STUDIO_EN}: ${STORE_EN} and ${CHAT_EN}`,
      desc: `${STUDIO_EN} builds software for merchants in Egypt: ${STORE_EN} for your online store and ${CHAT_EN} for your customers on WhatsApp. One account for both.`,
    },
    eyebrow: STUDIO_EN,
    h1: 'Your store and your customers, in one place.',
    lead: `${STORE_EN} opens your online store, and ${CHAT_EN} talks to your customers on WhatsApp. You sign in to both with the same account.`,
    productsH: 'Our products',
    store: {
      blurb: 'Your online store in minutes, in Arabic and in your own style.',
      cta: 'Open your store',
      more: `Learn more about ${STORE_EN}`,
    },
    chat: {
      blurb: 'Sell and support your customers on WhatsApp from one place.',
      cta: `Start with ${CHAT_EN}`,
      more: `Learn more about ${CHAT_EN}`,
    },
    account: 'One account for both, no second password.',
    windows: { storeFamily: 'Eight-point star', chatFamily: 'Six-point star' },
    does: {
      label: 'What we do',
      statement: 'We build AI-powered software so merchants in Egypt can sell more and work less.',
      items: [
        {
          h: 'Artificial intelligence',
          p: 'An assistant that writes, replies and organises with you, no technical know-how needed.',
        },
        {
          h: 'Software',
          p: 'A store and a chat tool, ready in Arabic, built for the phone first.',
        },
        {
          h: 'Digital marketing',
          p: 'Tools that bring customers in and back again, with clear numbers on what worked.',
        },
      ],
    },
    products: {
      label: 'Our products',
      storeFacts: [
        'Ready-made templates in Arabic',
        'Payments and shipping in one place',
        'AI built into the store to help with your daily work',
      ],
      chatFacts: [
        'One inbox for every WhatsApp message',
        'Quick replies and campaigns for your customers',
        'Linked to your store with the same account',
      ],
    },
    steps: {
      label: 'How to start',
      h: 'Three steps and you are live.',
      items: [
        {
          h: 'Create your account',
          p: 'With your email only, and the same account opens both products.',
        },
        {
          h: 'Pick a product and set it up',
          p: 'A store in your own style, or a chat linked to your business WhatsApp number.',
        },
        {
          h: 'Sell and reply to customers',
          p: 'And if you get stuck, our team answers in Arabic.',
        },
      ],
    },
    trust: {
      label: 'Trust and contact',
      h: 'An Egyptian company that speaks your language.',
      items: [
        { h: 'One account', p: 'You sign in to Ebda Store and Ebda Chat with the same account.' },
        {
          h: 'Written policies',
          p: 'Terms, privacy and refunds are published and readable, with no hidden clauses.',
        },
        {
          h: 'Someone answers',
          p: 'Email, WhatsApp and a help centre, and we answer your questions before you start.',
        },
      ],
      contactCta: 'Talk to us',
      legalLabel: 'Terms and privacy',
    },
  },
};
