// Sort logic of the storefront search page (pure; SearchClient.tsx renders it).
import type { Product } from '@/lib/api';
import { translations } from '../../contexts/LanguageContext';

// `relevance` = keep the server's order. It is the default; the server ranks a search (hybrid
// keyword + semantic, Task 12) only when semantic search is on, and says so in `meta.ranked`.
// Otherwise its order is newest-first, so the selector shows "Newest" and nothing changes.
export const sortValues = ['relevance', 'newest', 'price-asc', 'price-desc', 'name-asc'] as const;

export type SortValue = (typeof sortValues)[number];

/** Build sort options with translated labels ("Most relevant" only for a ranked list). */
export function getSortOptions(t: (en: string, ar: string) => string, ranked: boolean) {
  return [
    ...(ranked
      ? [{ value: 'relevance' as const, label: t('Most relevant', translations['Most relevant']) }]
      : []),
    { value: 'newest' as const, label: t('Newest', '\u0627\u0644\u0623\u062d\u062f\u062b') },
    {
      value: 'price-asc' as const,
      label: t(
        'Price: Low to High',
        '\u0627\u0644\u0633\u0639\u0631: \u0645\u0646 \u0627\u0644\u0623\u0642\u0644 \u0644\u0644\u0623\u0639\u0644\u0649'
      ),
    },
    {
      value: 'price-desc' as const,
      label: t(
        'Price: High to Low',
        '\u0627\u0644\u0633\u0639\u0631: \u0645\u0646 \u0627\u0644\u0623\u0639\u0644\u0649 \u0644\u0644\u0623\u0642\u0644'
      ),
    },
    {
      value: 'name-asc' as const,
      label: t('Name A-Z', '\u0627\u0644\u0627\u0633\u0645 \u0623-\u064a'),
    },
  ];
}

/** Sort products client-side so the UI responds instantly. */
export function sortProducts(products: Product[], sortBy: SortValue): Product[] {
  const copy = [...products];
  switch (sortBy) {
    case 'relevance':
      return copy;
    case 'price-asc':
      return copy.sort((a, b) => a.price - b.price);
    case 'price-desc':
      return copy.sort((a, b) => b.price - a.price);
    case 'name-asc':
      return copy.sort((a, b) => a.name.localeCompare(b.name));
    case 'newest':
    default:
      return copy.sort((a, b) => {
        if (a.createdAt && b.createdAt) {
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
        return 0;
      });
  }
}

/** An unranked list is newest-first, so the default reads (and sorts) as "Newest". */
export function displaySort(sortBy: SortValue, ranked: boolean): SortValue {
  return sortBy === 'relevance' && !ranked ? 'newest' : sortBy;
}
