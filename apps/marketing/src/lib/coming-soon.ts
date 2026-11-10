import { BRAND } from '@ebda/shared/brand';
import { serviceLinesPublished } from './service-lines';
import type { Locale } from './site';

/**
 * The COMING SOON product cards in the studio home's Products area (Ruling SERVICES-IA-1, coordinator addition 2026-11-09). They show
 * only when the service lines are PUBLISHED (the same one reveal, `EBDA_SERVICE_LINES=on`). Live products (Ebda Store, Ebda Chat)
 * are unchanged and still the only ones in the nav and the footer (BRAND-ARCH-1). Honest wording: no dates, no prices, no waitlist
 * form; the "notify me" CTA opens the studio contact form with the `products` topic preselected.
 * DRAFT until Ahmad approves: the Arabic product names, every blurb and fact.
 * SOFTWARE only: the Products area is for software; the studio's on-the-ground services (Ebda Events, Ebda Marketing, Ebda Design) live under Services. The card names differ from the service names on purpose (names confirmed by Ahmad 2026-11-09; the Arabic follows the BRAND pattern of transliterating the English name, as in ابدأ ستور / ابدأ شات: ابدأ إنفايت, ابدأ آدز): Ebda Invite vs the Events service, Ebda Ads vs the Marketing service, Ebda Quote Studio vs the Design service.
 * Three cards: Ebda Quote Studio, Ebda Events, Ebda Marketing (approved by Ahmad 2026-11-09, same release flag, no separate one).
 * Plus Ebda CRM and Ebda ERP (Ahmad 2026-11-10, Ruling COMING-SOON-CRM-ERP-1): built like the others, and each ALSO links to its own
 * live coming-soon page (`href`: crm.ebda.app / erp.ebda.app, served by the storefront Worker, unchanged here). DRAFT until Ahmad
 * approves: their blurbs and facts (plain descriptions only; no dates, prices or feature promises).
 */
export const comingSoonVisible = () => serviceLinesPublished();

export type ComingSoonId = 'quote-studio' | 'invite' | 'ads' | 'crm' | 'erp';
export type ComingSoon = {
  id: ComingSoonId;
  name: string;
  /** one short line for the nav menu */
  short: string;
  blurb: string;
  facts: string[];
  /** the product's own live page (only CRM and ERP have one); the card links to it next to the "notify me" CTA */
  href?: string;
};

/** The live coming-soon subdomain pages; the other cards have no site yet. */
const HREF: Partial<Record<ComingSoonId, string>> = {
  crm: 'https://crm.ebda.app/',
  erp: 'https://erp.ebda.app/',
};

const COPY = {
  ar: {
    label: 'قريبًا',
    notify: 'عرّفني أول ما يجهز',
    visit: 'زور',
    items: {
      'quote-studio': {
        blurb:
          'للمهندسين الداخليين ومكاتب التصميم: بتعرض تصميمك على عميلك في رابط، وهو بيغيّر الخامات والألوان ويشوف السعر مباشرة.',
        facts: [
          'ارفع تصميماتك وابعت رابط للعميل',
          'العميل يغيّر الخامات والألوان ويشوف السعر لحظيًا',
          'العميل يوافق من نفس الرابط',
          'عرض واقع معزز وافتراضي للتصميم',
        ],
      },
      invite: {
        blurb:
          'برنامج لتنظيم الفعاليات: صفحة للفعالية وتذاكر، ودعوات على واتساب وتأكيد حضور، وتسجيل دخول بالـ QR، ومتابعة بعد الفعالية.',
        facts: [
          'صفحة الفعالية والتذاكر',
          'دعوات على واتساب وتأكيد الحضور',
          'تسجيل دخول بالـ QR',
          'متابعة بعد الفعالية',
        ],
      },
      ads: {
        blurb:
          'برنامج تسويق من ابدأ ستوديو: إعلاناتك ومبيعاتك ومحادثات عملائك في مكان واحد، بالجنيه المصري.',
        facts: [
          'لوحة إعلانات واحدة بالجنيه المصري لكل المنصات اللي بتعلن عليها: ميتا وإنستجرام وتيك توك وجوجل',
          'ربط المبيعات بالإعلان اللي جابها، من طلبات ابدأ ستور',
          'إعلانات بالعربي بالذكاء الاصطناعي من صور منتجاتك',
          'كل عميل جاي من إعلان بيتردّ عليه على واتساب من خلال ابدأ شات',
          'تقويم محتوى وموافقات بضغطة واحدة',
          'خطة تسويق وتحليل SWOT وشخصيات عملاء وتقرير شهري بالذكاء الاصطناعي',
          'وضع الوكالة لإدارة أكتر من عميل',
        ],
      },
      crm: {
        blurb:
          'برنامج لإدارة عملائك: العملاء والعملاء المحتملين والمتابعات في مكان واحد، للتجار والفرق في مصر، ومربوط بابدأ ستور وابدأ شات.',
        facts: [
          'كل عملائك وبياناتهم في مكان واحد',
          'العملاء المحتملين ووصل كل واحد فيهم لفين',
          'المتابعات مع كل عميل في مكانها',
          'مربوط بطلبات ابدأ ستور ومحادثات ابدأ شات',
        ],
      },
      erp: {
        blurb:
          'برنامج لإدارة شغلك من جوه: المخزون والمشتريات وأساسيات الحسابات والفروع في مكان واحد، ومربوط بابدأ ستور.',
        facts: [
          'المخزون في كل فروعك',
          'المشتريات والموردين',
          'أساسيات الحسابات',
          'مربوط بمنتجات وطلبات ابدأ ستور',
        ],
      },
    },
  },
  en: {
    label: 'Coming soon',
    notify: 'Tell me when it is ready',
    visit: 'Visit',
    items: {
      'quote-studio': {
        blurb:
          'For interior engineers and design offices: share your design with a client in one link, and they change materials and colours and see the live price.',
        facts: [
          'Upload your designs and share a link with the client',
          'The client changes materials and colours and sees the live price',
          'The client approves from the same link',
          'AR and VR views of the design',
        ],
      },
      invite: {
        blurb:
          'A product for running events: an event page and tickets, WhatsApp invitations and RSVP, QR check-in and post-event follow-up.',
        facts: [
          'An event page and tickets',
          'WhatsApp invitations and RSVP',
          'QR check-in',
          'Post-event follow-up',
        ],
      },
      ads: {
        blurb:
          'A marketing platform from Ebda AI Studio: your ads, sales and customer conversations in one place, in Egyptian pounds.',
        facts: [
          'One ads dashboard in EGP across where your ads run: Meta, Instagram, TikTok and Google',
          'Sales linked to the ad that brought them, from Ebda Store orders',
          'AI ad creative in Arabic, made from your product photos',
          'Every lead from an ad answered on WhatsApp through Ebda Chat',
          'A content calendar with one-tap approvals',
          'An AI marketing plan, SWOT, customer personas and monthly report',
          'Agency mode for managing many clients',
        ],
      },
      crm: {
        blurb:
          'A product for managing your customers: customers, leads and follow-ups in one place, for Egyptian merchants and teams, connected to Ebda Store and Ebda Chat.',
        facts: [
          'All your customers and their details in one place',
          'Leads and where each one stands',
          'Follow-ups with every customer, kept in one place',
          'Connected to Ebda Store orders and Ebda Chat conversations',
        ],
      },
      erp: {
        blurb:
          'A product for running the back office: inventory, purchasing, accounting basics and branches in one place, connected to Ebda Store.',
        facts: [
          'Inventory across your branches',
          'Purchasing and suppliers',
          'Accounting basics',
          'Connected to Ebda Store products and orders',
        ],
      },
    },
  },
} as const;

export const comingSoonLabels = (locale: Locale) => ({
  label: COPY[locale].label,
  notify: COPY[locale].notify,
  visit: COPY[locale].visit,
});

/** The cards to show for a locale (empty unless published). */
export function comingSoonItems(locale: Locale): ComingSoon[] {
  if (!comingSoonVisible()) return [];
  const ids: ComingSoonId[] = ['quote-studio', 'invite', 'ads', 'crm', 'erp'];
  return ids.map(id => {
    const b = BRAND.comingProducts.find(p => p.id === id)!;
    return {
      id,
      name: locale === 'ar' ? b.nameAr : b.nameEn,
      short: locale === 'ar' ? b.shortAr : b.shortEn,
      ...COPY[locale].items[id],
      facts: [...COPY[locale].items[id].facts],
      ...(HREF[id] ? { href: HREF[id] } : {}),
    };
  });
}
