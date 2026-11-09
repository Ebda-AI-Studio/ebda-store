import { pagePath, type Locale, type PageSlug } from '../lib/site';

/**
 * Plain crawlable links from the Ebda Store landing to the pages that otherwise hang off nothing but the sitemap: the five
 * business-type pages (/for/*) and the six comparisons (/compare/*). Search Console (2026-11-09) listed 54 sitemap pages as
 * "Discovered, currently not indexed"; these 22 had one inbound link or none from the home or the nav. The footer carries no
 * competitor links on purpose (Ahmad 2026-10-23), so the links live in the page body.
 */
const COPY: Record<
  Locale,
  {
    forTitle: string;
    cmpTitle: string;
    aria: string;
    vertical: Record<string, string>;
    compare: Record<string, string>;
  }
> = {
  ar: {
    aria: 'صفحات مفيدة',
    forTitle: 'متجر لكل نوع نشاط',
    cmpTitle: 'قارن ابدأ ستور بغيره',
    vertical: {
      fashion: 'أزياء وبوتيكات',
      electronics: 'إلكترونيات',
      beauty: 'عناية وجمال',
      food: 'أكل ومطبخ منزلي',
      jewellery: 'مجوهرات وهدايا',
    },
    compare: {
      zid: 'مقابل زد',
      shopify: 'مقابل شوبيفاي',
      wuilt: 'مقابل ويلت',
      youcan: 'مقابل يوكان',
      easyorders: 'مقابل إيزي أوردرز',
      expandcart: 'مقابل إكسباند كارت',
    },
  },
  en: {
    aria: 'Useful pages',
    forTitle: 'A store for every kind of business',
    cmpTitle: 'Compare Ebda Store',
    vertical: {
      fashion: 'Fashion and boutiques',
      electronics: 'Electronics',
      beauty: 'Beauty and skincare',
      food: 'Food and home kitchens',
      jewellery: 'Jewellery and gifts',
    },
    compare: {
      zid: 'vs Zid',
      shopify: 'vs Shopify',
      wuilt: 'vs Wuilt',
      youcan: 'vs YouCan',
      easyorders: 'vs EasyOrders',
      expandcart: 'vs ExpandCart',
    },
  },
};

export function ExploreLinks({ locale }: { locale: Locale }) {
  const c = COPY[locale];
  const href = (p: string) => `${pagePath(locale, p as PageSlug)}/`;
  return (
    <nav className="explore" aria-label={c.aria}>
      <h3>{c.forTitle}</h3>
      <ul>
        {Object.entries(c.vertical).map(([slug, label]) => (
          <li key={slug}>
            <a href={href(`for/${slug}`)}>{label}</a>
          </li>
        ))}
      </ul>
      <h3>{c.cmpTitle}</h3>
      <ul>
        {Object.entries(c.compare).map(([slug, label]) => (
          <li key={slug}>
            <a href={href(`compare/${slug}`)}>{label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
