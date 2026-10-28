'use client';

import { useState } from 'react';
import { isOnSale } from '../../lib/product-pricing';
import Link from '../../components/StoreLink';
import Image from 'next/image';
import { ShopChrome } from '../../components';
import { useCart } from '../../contexts/CartContext';
import { useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { compareStorageKey } from '../../lib/compare';
import type { ProductFact } from '@ebda/shared';
import { compareFactRows } from '../../lib/compare-facts';

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
  const money = useLocalePrice();

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
          <h1 className="text-3xl font-bold mb-8">{t('Compare Products', 'مقارنة المنتجات')}</h1>
          <div className="animate-pulse bg-muted h-96 rounded-lg"></div>
        </div>
      </ShopChrome>
    );
  }

  if (products.length === 0) {
    return (
      <ShopChrome>
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">{t('Compare Products', 'مقارنة المنتجات')}</h1>
          <div className="text-center py-12 bg-muted rounded-lg">
            <svg
              className="w-16 h-16 text-muted-foreground mx-auto mb-4"
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
              {t('No products to compare', 'مفيش منتجات للمقارنة')}
            </h2>
            <p className="text-muted-foreground mb-4">
              {t('Add products to compare their features', 'ضيف منتجات عشان تقارن مميزاتها')}
            </p>
            <Link
              href={storeUrl('/products')}
              className="inline-flex items-center px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
            >
              {t('Browse Products', 'تصفح المنتجات')}
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

  // One row per distinct (EN, AR) fact name pair; "—" where a product lacks it.
  const factRows = compareFactRows(products, language === 'ar' ? 'ar' : 'en');

  return (
    <ShopChrome>
      <div className="container mx-auto px-4 py-8 flex-1">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">{t('Compare Products', 'مقارنة المنتجات')}</h1>
          <button
            type="button"
            onClick={clearAll}
            className="text-destructive-ink hover:text-destructive-ink/80 text-sm"
          >
            {t('Clear All', 'مسح الكل')}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px]">
            <thead>
              <tr>
                <th className="text-left p-4 bg-muted w-1/4">{t('Product', 'المنتج')}</th>
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
                            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
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
                <td className="p-4 font-medium text-muted-foreground">{t('Price', 'السعر')}</td>
                {products.map(product => (
                  <td key={product.id} className="p-4 text-center">
                    <span className="font-bold text-lg">{money(product.price)}</span>
                    {isOnSale(product) && (
                      <span className="block text-muted-foreground line-through text-sm">
                        {money(product.compareAtPrice)}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
              <tr className="border-t">
                <td className="p-4 font-medium text-muted-foreground">
                  {t('Description', 'الوصف')}
                </td>
                {products.map(product => (
                  <td key={product.id} className="p-4 text-center text-sm text-muted-foreground">
                    {product.description ? (
                      <p className="line-clamp-3">{product.description}</p>
                    ) : (
                      <span className="text-muted-foreground">-</span>
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
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {factRows.map(row => (
                <tr key={`fact-${row.id}`} className="border-t">
                  <td className="p-4 font-medium text-muted-foreground">{row.label}</td>
                  {products.map(product => (
                    <td key={product.id} className="p-4 text-center text-sm">
                      {row.values[product.id] || (
                        <span className="text-muted-foreground">&mdash;</span>
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
                      className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
                    >
                      {t('Add to Cart', 'أضف إلى السلة')}
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
