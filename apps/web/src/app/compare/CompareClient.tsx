'use client';

import { useState } from 'react';
import { isOnSale } from '../../lib/product-pricing';
import Link from 'next/link';
import Image from 'next/image';
import { ShopChrome } from '../../components';
import { useCart } from '../../contexts/CartContext';
import { useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { compareStorageKey } from '../../lib/compare';
import { factText, type ProductFact } from '@ebda/shared';

interface CompareProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  compareAtPrice?: number;
  images: string[];
  description?: string;
  specifications?: Record<string, string>;
  facts?: ProductFact[];
}

// Load compare products from localStorage
function loadInitialProducts(): CompareProduct[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(compareStorageKey());
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error('Failed to load compare products:', error);
  }
  return [];
}

export default function CompareClient() {
  const [products, setProducts] = useState<CompareProduct[]>(() => loadInitialProducts());
  const [isLoading] = useState(false);
  const { addItem } = useCart();
  const storeUrl = useStoreUrl();
  const { t, language } = useLanguage();
  const { money } = useNumerals();

  function handleAddToCart(product: CompareProduct) {
    addItem({
      id: product.id,
      name: product.name,
      price: product.price,
      slug: product.slug,
      image: product.images?.[0],
    });
    // Add-to-cart toast is centralized in CartContext.addItem (Group E) —
    // don't double-toast from per-component callers.
  }

  function removeProduct(productId: string) {
    const updated = products.filter(p => p.id !== productId);
    setProducts(updated);
    localStorage.setItem(compareStorageKey(), JSON.stringify(updated));
  }

  function clearAll() {
    setProducts([]);
    localStorage.removeItem(compareStorageKey());
  }

  if (isLoading) {
    return (
      <ShopChrome>
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">
            {t(
              'Compare Products',
              '\u0645\u0642\u0627\u0631\u0646\u0629 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a'
            )}
          </h1>
          <div className="animate-pulse bg-muted h-96 rounded-lg"></div>
        </div>
      </ShopChrome>
    );
  }

  if (products.length === 0) {
    return (
      <ShopChrome>
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">
            {t(
              'Compare Products',
              '\u0645\u0642\u0627\u0631\u0646\u0629 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a'
            )}
          </h1>
          <div className="text-center py-12 bg-muted rounded-lg">
            <svg
              className="w-16 h-16 text-muted-foreground/70 mx-auto mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            <h2 className="text-xl font-semibold mb-2">
              {t(
                'No products to compare',
                '\u0644\u0627 \u062a\u0648\u062c\u062f \u0645\u0646\u062a\u062c\u0627\u062a \u0644\u0644\u0645\u0642\u0627\u0631\u0646\u0629'
              )}
            </h2>
            <p className="text-muted-foreground mb-4">
              {t(
                'Add products to compare their features',
                '\u0623\u0636\u0641 \u0645\u0646\u062a\u062c\u0627\u062a \u0644\u0645\u0642\u0627\u0631\u0646\u0629 \u0645\u064a\u0632\u0627\u062a\u0647\u0627'
              )}
            </p>
            <Link
              href={storeUrl('/products')}
              className="inline-flex items-center px-6 py-3 bg-primary text-white rounded-lg hover:bg-primary/90"
            >
              {t(
                'Browse Products',
                '\u062a\u0635\u0641\u062d \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a'
              )}
            </Link>
          </div>
        </div>
      </ShopChrome>
    );
  }

  // Get all unique specification keys
  const allSpecs = new Set<string>();
  products.forEach(p => {
    if (p.specifications) {
      Object.keys(p.specifications).forEach(key => allSpecs.add(key));
    }
  });

  // One row per distinct fact name across the compared products (first-seen
  // order). A fact matches a row by its English OR Arabic name, so products that
  // name the same fact in different languages still share a row. "—" where a
  // product lacks the key.
  const lang = language === 'ar' ? 'ar' : 'en';
  const names = (f: ProductFact) =>
    [f.key, f.keyAr].map(k => k.trim().toLowerCase()).filter(Boolean);
  const factRows: Array<{ names: Set<string>; label: string }> = [];
  products.forEach(p =>
    (p.facts ?? []).forEach(f => {
      const row = factRows.find(r => names(f).some(n => r.names.has(n)));
      if (row) names(f).forEach(n => row.names.add(n));
      else factRows.push({ names: new Set(names(f)), label: factText(f, lang).key });
    })
  );
  const factValue = (p: CompareProduct, rowNames: Set<string>) => {
    const f = p.facts?.find(x => names(x).some(n => rowNames.has(n)));
    return f ? factText(f, lang).value : '';
  };

  return (
    <ShopChrome>
      <div className="container mx-auto px-4 py-8 flex-1">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">
            {t(
              'Compare Products',
              '\u0645\u0642\u0627\u0631\u0646\u0629 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a'
            )}
          </h1>
          <button
            type="button"
            onClick={clearAll}
            className="text-destructive-ink hover:text-destructive-ink/80 text-sm"
          >
            {t('Clear All', '\u0645\u0633\u062d \u0627\u0644\u0643\u0644')}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px]">
            <thead>
              <tr>
                <th className="text-left p-4 bg-muted w-1/4">
                  {t('Product', '\u0627\u0644\u0645\u0646\u062a\u062c')}
                </th>
                {products.map(product => (
                  <th key={product.id} className="p-4 bg-muted">
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => removeProduct(product.id)}
                        aria-label={t('Remove from compare', 'إزالة من المقارنة')}
                        className="absolute -top-2 -right-2 p-1 bg-destructive/20 rounded-full text-destructive-ink hover:bg-destructive/30"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                      <Link href={storeUrl(`/products/${product.slug}`)}>
                        <div className="w-32 h-32 mx-auto bg-muted rounded-lg overflow-hidden mb-2">
                          {product.images?.[0] ? (
                            <Image
                              src={product.images[0]}
                              alt={product.name}
                              width={128}
                              height={128}
                              className="w-full h-full object-cover"
                              sizes="128px"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-muted-foreground/70">
                              <svg
                                className="w-8 h-8"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={1.5}
                                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                                />
                              </svg>
                            </div>
                          )}
                        </div>
                        <h3 className="font-semibold text-sm hover:text-primary line-clamp-2">
                          {product.name}
                        </h3>
                      </Link>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t">
                <td className="p-4 font-medium text-muted-foreground">
                  {t('Price', '\u0627\u0644\u0633\u0639\u0631')}
                </td>
                {products.map(product => (
                  <td key={product.id} className="p-4 text-center">
                    <span className="font-bold text-lg">{money(product.price)} EGP</span>
                    {isOnSale(product) && (
                      <span className="block text-muted-foreground/70 line-through text-sm">
                        {money(product.compareAtPrice)} EGP
                      </span>
                    )}
                  </td>
                ))}
              </tr>
              <tr className="border-t">
                <td className="p-4 font-medium text-muted-foreground">
                  {t('Description', '\u0627\u0644\u0648\u0635\u0641')}
                </td>
                {products.map(product => (
                  <td key={product.id} className="p-4 text-center text-sm text-muted-foreground">
                    {product.description ? (
                      <p className="line-clamp-3">{product.description}</p>
                    ) : (
                      <span className="text-muted-foreground/70">-</span>
                    )}
                  </td>
                ))}
              </tr>
              {Array.from(allSpecs).map(spec => (
                <tr key={spec} className="border-t">
                  <td className="p-4 font-medium text-muted-foreground">{spec}</td>
                  {products.map(product => (
                    <td key={product.id} className="p-4 text-center text-sm">
                      {product.specifications?.[spec] || (
                        <span className="text-muted-foreground/70">-</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {factRows.map(row => (
                <tr key={`fact-${row.label}`} className="border-t">
                  <td className="p-4 font-medium text-muted-foreground">{row.label}</td>
                  {products.map(product => (
                    <td key={product.id} className="p-4 text-center text-sm">
                      {factValue(product, row.names) || (
                        <span className="text-muted-foreground/70">&mdash;</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t">
                <td className="p-4"></td>
                {products.map(product => (
                  <td key={product.id} className="p-4 text-center">
                    <button
                      type="button"
                      onClick={() => handleAddToCart(product)}
                      className="w-full px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90"
                    >
                      {t(
                        'Add to Cart',
                        '\u0623\u0636\u0641 \u0625\u0644\u0649 \u0627\u0644\u0633\u0644\u0629'
                      )}
                    </button>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </ShopChrome>
  );
}
