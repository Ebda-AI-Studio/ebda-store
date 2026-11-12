import { BRAND } from '@ebda/shared/brand';
import { serviceLinesPublished } from './service-lines';
import type { Locale } from './site';

/**
 * The COMING SOON product cards in the studio home's Products area (Ruling SERVICES-IA-1, coordinator addition 2026-11-09). They show
 * only when the service lines are PUBLISHED (the same one reveal, `EBDA_SERVICE_LINES=on`). Live products (Ebda Store, Ebda Chat)
 * are unchanged and still the only ones in the nav and the footer (BRAND-ARCH-1). Honest wording: no dates, no prices, no waitlist
 * form; the "notify me" CTA opens the studio contact form with the `products` topic preselected.
 * DRAFT until Ahmad approves: the Arabic product names, every blurb and fact.
 * SOFTWARE only: the Products area is for software; the studio's on-the-ground services live under Services.
 * Only Ebda CRM and Ebda ERP are "coming soon" (Ahmad 2026-11-10, Ruling COMING-SOON-CRM-ERP-1; 2026-11-11 public-copy rule: nothing else is
 * ever announced as coming). A card only offers "notify me": the <label>.ebda.app coming-soon pages stay live (Ruling SUBDOMAIN-SOON-2)
 * but are never linked as "visit" (Ruling COMING-SOON-NO-VISIT-1: a visit link reads as if the product exists). DRAFT until Ahmad approves: the CRM and ERP blurbs and facts (plain
 * descriptions only; no dates, prices or feature promises).
 */
export const comingSoonVisible = () => serviceLinesPublished();

export type ComingSoonId = 'crm' | 'erp';
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
    items: {
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
});

/** The cards to show for a locale (empty unless published). */
export function comingSoonItems(locale: Locale): ComingSoon[] {
  if (!comingSoonVisible()) return [];
  const ids: ComingSoonId[] = ['crm', 'erp'];
  return ids.map(id => {
    const b = BRAND.comingProducts.find(p => p.id === id)!;
    return {
      id,
      name: locale === 'ar' ? b.nameAr : b.nameEn,
      short: locale === 'ar' ? b.shortAr : b.shortEn,
      ...COPY[locale].items[id],
      facts: [...COPY[locale].items[id].facts],
    };
  });
}
