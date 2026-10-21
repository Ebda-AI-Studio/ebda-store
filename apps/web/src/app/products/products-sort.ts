// Sort options of the storefront products page (pure; ProductsClient.tsx renders them).
import { translations } from '../../contexts/LanguageContext';

/** Sort option labels are translated at render time via the t() helper */
export function getSortOptions(t: (en: string, ar: string) => string, ranked = false) {
  return [
    // Default = the merchant's curated per-category order. Sends NO sort/featured
    // param so the API uses the ProductCategory.position path (all products in the
    // store's chosen order). MUST stay first + be the default \u2014 a category browse
    // should show the whole category, not a filtered collection.
    ranked
      ? // The server ranked this search (meta.ranked): the same option IS the relevance order.
        { value: 'default', label: t('Most relevant', translations['Most relevant']) }
      : {
          value: 'default',
          label: t('Recommended', '\u0627\u0644\u0645\u064f\u0648\u0635\u0649 \u0628\u0647'),
        },
    { value: 'featured', label: t('Featured', '\u0645\u0645\u064a\u0632') },
    { value: 'newest', label: t('Newest', '\u0627\u0644\u0623\u062d\u062f\u062b') },
    {
      value: 'best_seller',
      label: t(
        'Best sellers',
        '\u0627\u0644\u0623\u0643\u062b\u0631 \u0645\u0628\u064a\u0639\u0627\u064b'
      ),
    },
    {
      value: 'price-asc',
      label: t(
        'Price: Low to High',
        '\u0627\u0644\u0633\u0639\u0631: \u0645\u0646 \u0627\u0644\u0623\u0642\u0644 \u0644\u0644\u0623\u0639\u0644\u0649'
      ),
    },
    {
      value: 'price-desc',
      label: t(
        'Price: High to Low',
        '\u0627\u0644\u0633\u0639\u0631: \u0645\u0646 \u0627\u0644\u0623\u0639\u0644\u0649 \u0644\u0644\u0623\u0642\u0644'
      ),
    },
  ];
}
