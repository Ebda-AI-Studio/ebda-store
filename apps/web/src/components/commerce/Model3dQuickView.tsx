'use client';
import { useEffect, useState } from 'react';
import { api, type Product } from '@/lib/api';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStore, useStoreUrl } from '@/contexts/StoreContext';
import { Sheet } from '../ui/Sheet';
import Link from '../StoreLink';
import { ProductModel3dPanel } from '../ProductModel3d';

type State = { kind: 'loading' } | { kind: 'ready'; product: Product } | { kind: 'none' };

/**
 * Quick view: the product's 3D model in a modal over the listing. Reads the PDP payload (the
 * same API route the product page uses, so `product_3d` is applied server-side: with the feature
 * off there is no `model3d` and the dialog says so instead of a dead viewer). Loaded lazily by
 * <Model3dChip> only after a tap; the viewer inside is itself a further lazy chunk.
 */
export default function Model3dQuickView({
  slug,
  fallbackName,
  onClose,
}: {
  slug: string;
  fallbackName: string;
  onClose: () => void;
}) {
  const { language, t } = useLanguage();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const isRtl = language === 'ar';
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    api
      .getProduct(slug)
      .then(res => {
        if (!live) return;
        const product = res.success ? res.data?.product : undefined;
        setState(product?.model3d ? { kind: 'ready', product } : { kind: 'none' });
      })
      .catch(() => live && setState({ kind: 'none' }));
    return () => {
      live = false;
    };
  }, [slug]);

  const product = state.kind === 'ready' ? state.product : null;
  const name = product
    ? (isRtl ? product.nameAr || product.name : product.name) || fallbackName
    : fallbackName;

  return (
    <Sheet
      open
      onClose={onClose}
      side="center"
      dir={isRtl ? 'rtl' : 'ltr'}
      title={name}
      closeLabel={t('Close', 'إغلاق')}
      footer={
        <Link
          href={`${storeUrl}/products/${slug}`}
          className="inline-flex h-11 w-full items-center justify-center rounded-full bg-foreground px-5 text-sm font-semibold text-background"
        >
          {t('View product details', 'شوف تفاصيل المنتج')}
        </Link>
      }
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-[var(--radius)] bg-muted/30">
        {state.kind === 'loading' ? (
          <p role="status" className="absolute inset-0 grid place-items-center text-sm">
            {t('Loading 3D…', 'بنحمّل الـ 3D…')}
          </p>
        ) : null}
        {state.kind === 'none' ? (
          <p
            role="status"
            className="absolute inset-0 grid place-items-center px-6 text-center text-sm"
          >
            {t('3D view unavailable right now.', 'عرض الـ 3D مش متاح دلوقتي.')}
          </p>
        ) : null}
        {product?.model3d ? (
          <ProductModel3dPanel
            model={product.model3d}
            storeId={store?.id ?? ''}
            productId={product.id}
            productName={name}
            fallbackPoster={product.images?.[0]?.url}
            selected={{}}
            optionOrder={[]}
            isRtl={isRtl}
            t={t}
          />
        ) : null}
      </div>
    </Sheet>
  );
}
