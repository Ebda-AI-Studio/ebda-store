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
 */
export const comingSoonVisible = () => serviceLinesPublished();

export type ComingSoonId = 'quote-studio' | 'invite' | 'ads';
export type ComingSoon = {
  id: ComingSoonId;
  name: string;
  /** one short line for the nav menu */
  short: string;
  blurb: string;
  facts: string[];
};

const COPY = {
  ar: {
    label: 'قريبًا',
    notify: 'عرّفني أول ما يجهز',
    items: {
      'quote-studio': {
        short: 'عروض أسعار تفاعلية لمكاتب التصميم',
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
        short: 'دعوات وحضور الفعاليات',
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
        short: 'إعلاناتك ومبيعاتك في مكان واحد',
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
    },
  },
  en: {
    label: 'Coming soon',
    notify: 'Tell me when it is ready',
    items: {
      'quote-studio': {
        short: 'Live quotes for design offices',
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
        short: 'Invitations and event attendance',
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
        short: 'Your ads and sales in one place',
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
    },
  },
} as const;

export const comingSoonLabels = (locale: Locale) => ({
  label: COPY[locale].label,
  notify: COPY[locale].notify,
});

/** The cards to show for a locale (empty unless published). */
export function comingSoonItems(locale: Locale): ComingSoon[] {
  if (!comingSoonVisible()) return [];
  const ids: ComingSoonId[] = ['quote-studio', 'invite', 'ads'];
  return ids.map(id => {
    const b = BRAND.comingProducts.find(p => p.id === id)!;
    return {
      id,
      name: locale === 'ar' ? b.nameAr : b.nameEn,
      ...COPY[locale].items[id],
      facts: [...COPY[locale].items[id].facts],
    };
  });
}
