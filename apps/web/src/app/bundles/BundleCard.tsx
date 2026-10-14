'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Button } from '@ebda/ui';
import type { PublicBundle } from '@/lib/api';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { useCart } from '../../contexts/CartContext';
import { useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { pickBundleName } from '@/lib/bundle-locale';
import { trackAddToCart } from '../../components/MarketingPixels';
import { BundlePlaceholderIcon } from '../../components/BundleLine';

import { fromMinor, REGION } from '@ebda/shared';
interface BundleCardProps {
  bundle: PublicBundle;
}

/**
 * One tile on the `/bundles` index grid — mirrors `ProductListItem`'s grid
 * card chrome (rounded-2xl bordered card, square image, name + price + Add
 * to Cart) trimmed to what a bundle actually needs. `bundles` (the list
 * this renders) is already pre-filtered to `isPurchasable` bundles only
 * (see `PublicBundle`'s doc comment on `api.ts`), so unlike the product
 * grid there is no out-of-stock state to render here.
 *
 * The savings badge sits at a fixed physical corner (`left-3`), never
 * RTL-mirrored — same rule the product grid's discount badge follows (see
 * `ProductListItem`'s own comment on `discountBadgePositionCls`).
 */
export function BundleCard({ bundle }: BundleCardProps) {
  const { language, t } = useLanguage();
  const formatPrice = useLocalePrice();
  const { addBundle } = useCart();
  const storeUrl = useStoreUrl();
  const [isAdding, setIsAdding] = useState(false);

  const displayName = pickBundleName(bundle, language);
  const savings = bundle.componentSum - bundle.price;

  const handleAddToCart = async () => {
    setIsAdding(true);
    const added = await addBundle(bundle.id, 1);
    setIsAdding(false);
    if (!added) return;
    trackAddToCart({
      contentId: bundle.id,
      contentName: bundle.name,
      quantity: 1,
      value: fromMinor(bundle.price),
      currency: REGION.currency,
    });
  };

  // The card is a positioned container, NOT one big <Link> (#1557): a
  // <button> nested in an <a> is invalid HTML, folds "Add to Cart" into the
  // link's accessible name, and on Safari/Firefox a tap on the disabled
  // (loading) button bubbled to the anchor and navigated mid-add. The title
  // link is stretched over the card (`after:inset-0`) so the whole tile still
  // opens the bundle, and the button sits above that overlay as a sibling —
  // the same shape as PecannbeeProductCard. Visually unchanged.
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card transition-all hover:border-primary/30 hover:shadow-lg">
      <div className="relative aspect-square overflow-hidden bg-gradient-to-br from-primary/5 to-primary/10">
        {bundle.image ? (
          <Image
            src={bundle.image}
            alt={displayName}
            fill
            className="object-cover transition-transform duration-300 group-hover:scale-105"
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
          />
        ) : (
          <BundlePlaceholderIcon />
        )}
        {savings > 0 && (
          <span className="absolute left-3 top-3 rounded-full bg-primary px-2.5 py-1 text-xs font-bold text-white">
            {t('Save', 'وفّر')} {formatPrice(savings)}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <span className="inline-flex w-fit items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {t('Bundle', 'باقة')}
        </span>
        <h3 className="line-clamp-2 text-base font-semibold text-foreground">
          <Link
            href={storeUrl(`/bundles/${bundle.slug}`)}
            className="after:absolute after:inset-0 after:content-['']"
          >
            {displayName}
          </Link>
        </h3>
        <div className="mt-auto flex items-center justify-between gap-2 pt-2">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-primary tabular-nums">
              {formatPrice(bundle.price)}
            </span>
            {savings > 0 && (
              <span className="text-xs text-muted-foreground line-through">
                {formatPrice(bundle.componentSum)}
              </span>
            )}
          </div>
          {/* #2198: the positioned z-10 layer is this WRAPPER, not the Button.
              While adding, @ebda/ui's Button is `disabled` and its base class
              carries `disabled:pointer-events-none`, so a z-10 BUTTON became
              transparent to hit-testing and the tap fell through to the
              stretched title link's `::after` overlay — navigating mid-add, the
              exact #1557 symptom. The span is never pointer-events-none, so it
              absorbs the tap in every state. */}
          <span className="relative z-10 shrink-0">
            <Button size="sm" onClick={handleAddToCart} isLoading={isAdding}>
              {t('Add to Cart', translations['Add to Cart'])}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
