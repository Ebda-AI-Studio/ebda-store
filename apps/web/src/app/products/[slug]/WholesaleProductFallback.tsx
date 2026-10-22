'use client';

/**
 * Wholesale-only product page for an APPROVED buyer (B2B review I2). The server renders a genuine 404 for a wholesale-only slug
 * (crawlers and anonymous shoppers must get the 404 status, and the cacheable HTML must hold nothing buyer-specific), so the
 * product page of a hidden product ends up in this segment's `not-found.tsx`. This client wrapper keeps that 404 as the
 * default and, for a signed-in shopper, asks the authenticated no-store `/public/wholesale/products/:slug` route: a member
 * gets the product page, everyone else keeps the 404 they were already shown.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useOptionalAuth } from '../../../contexts/AuthContext';
import ProductDetailClient from './ProductDetailClient';

type WholesaleProduct = NonNullable<
  Awaited<ReturnType<typeof api.getWholesaleProduct>>['data']
>['product'];

export default function WholesaleProductFallback({ children }: { children: ReactNode }) {
  const params = useParams<{ slug?: string }>();
  const slug = params?.slug ? decodeURIComponent(String(params.slug)) : null;
  const isAuthenticated = useOptionalAuth()?.isAuthenticated ?? false;
  const [product, setProduct] = useState<WholesaleProduct | null>(null);

  useEffect(() => {
    if (!slug || !isAuthenticated) return;
    let cancelled = false;
    void api
      .getWholesaleProduct(slug)
      .then(res => {
        if (!cancelled && res.success && res.data) setProduct(res.data.product);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [slug, isAuthenticated]);

  if (product) return <ProductDetailClient initialProduct={product} />;
  return <>{children}</>;
}
