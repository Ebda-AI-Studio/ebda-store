'use client';

/**
 * PDP 3D panel — the toggle button and the lazily loaded viewer.
 *
 * Performance budget (docs/plans/2026-10-07-product-3d-viewer.md): nothing 3D
 * is fetched until the shopper taps "3D". The viewer module (three.js +
 * loaders) is a `next/dynamic(ssr:false)` chunk, and the GLB is fetched by it.
 * The panel renders inside the gallery box, so it inherits the box's aspect —
 * no layout shift when it opens.
 */
import dynamic from 'next/dynamic';
import { useMemo, useRef } from 'react';
import { resolveModel3dLook, type PublicModel3d } from '@ebda/shared';
import { captureEvent } from './PostHogProvider';
import { useCurrentUrl } from '../hooks/useCurrentUrl';

const ProductModelViewer = dynamic(() => import('@ebda/ui/model3d'), {
  ssr: false,
  loading: () => null,
});

type T = (en: string, ar: string) => string;

export function Model3dToggle({
  active,
  onToggle,
  t,
}: {
  active: boolean;
  onToggle: () => void;
  t: T;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className="absolute top-3 end-3 z-10 inline-flex h-11 items-center gap-1.5 rounded-full border border-input bg-background/90 px-4 text-xs font-semibold text-foreground shadow-sm backdrop-blur hover:bg-background"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 0v9m8-4.5L12 12 4 7.5"
        />
      </svg>
      {active ? t('Photos', 'الصور') : t('View in 3D', 'اعرضه 3D')}
    </button>
  );
}

export function ProductModel3dPanel({
  model,
  storeId,
  productId,
  productName,
  fallbackPoster,
  selected,
  optionOrder,
  isRtl,
  t,
}: {
  model: PublicModel3d;
  storeId: string;
  productId: string;
  productName: string;
  fallbackPoster?: string;
  /** The shopper's current (possibly partial) option picks: { Metal: 'Gold' }. */
  selected: Record<string, string>;
  optionOrder: string[];
  isRtl: boolean;
  t: T;
}) {
  const look = useMemo(
    () => resolveModel3dLook(model.bindings, selected, optionOrder),
    [model.bindings, selected, optionOrder]
  );
  const base = { storeId, productId };
  const firstLook = useRef(true);
  const currentUrl = useCurrentUrl();
  const alt =
    (isRtl ? model.altTextAr || model.altText : model.altText || model.altTextAr) ||
    `${productName} — ${t('3D model', 'موديل ثلاثي الأبعاد')}`;

  return (
    <ProductModelViewer
      src={model.modelUrl}
      poster={model.posterUrl ?? fallbackPoster ?? null}
      alt={alt}
      look={look}
      labels={{
        loading: t('Loading 3D…', 'بنحمّل الـ 3D…'),
        error: t('3D view unavailable right now.', 'عرض الـ 3D مش متاح دلوقتي.'),
        hint: t(
          'Drag to rotate · pinch or +/− to zoom · arrow keys',
          'اسحب عشان تلفّه · قرّب بإصبعين أو +/− · الأسهم'
        ),
        ar: t('View in your space', 'اعرضه في مكانك'),
        arDesktop: {
          open: t('View in your space', 'اعرضه في مكانك'),
          title: t('Open it on your phone', 'افتحه على موبايلك'),
          hint: t(
            'Scan with your phone camera, then tap View in your space.',
            'صوّر الكود بكاميرا موبايلك، وبعدين دوس اعرضه في مكانك.'
          ),
          close: t('Close', 'قفل'),
        },
      }}
      ar={{
        enabled: model.arEnabled,
        usdzUrl: model.usdzUrl,
        title: productName,
        fallbackUrl: currentUrl,
      }}
      onLoad={info => captureEvent('product_3d_loaded', { ...base, ...info })}
      onError={reason => captureEvent('product_3d_load_failed', { ...base, reason })}
      onInteract={() => captureEvent('product_3d_interacted', base)}
      onArClick={source => captureEvent('product_3d_ar_clicked', { ...base, source })}
      onLookApplied={() => {
        // The first application is the file's default look, not a shopper act.
        if (firstLook.current) {
          firstLook.current = false;
          return;
        }
        captureEvent('product_3d_variant_applied', base);
      }}
    />
  );
}
