'use client';

import Link from 'next/link';
import Image from 'next/image';
import type { ProductCardProps } from '../types';
import { Price, ProductBadge, AddToCartButton, cn } from '@force/ui';
import { PlaceholderImageIcon } from '../shared/icons';

/**
 * Classic Template - Product Card
 *
 * Clean square grid card — solid border, subtle shadow on hover, aspect-square
 * image, serif name, classic price. No lift animation; border color change
 * + gentle image zoom on hover.
 */
export default function ClassicProductCard({
  product,
  isRtl = false,
  currency = 'KWD',
  quantityInCart = 0,
  onAddToCart,
  urlPrefix = '',
}: ProductCardProps) {
  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

  return (
    <Link href={`${urlPrefix}/products/${product.slug}`} className="group block cursor-pointer">
      {/* Image container — aspect-square, clean border */}
      <div className="relative aspect-square overflow-hidden bg-muted border border-border group-hover:border-foreground/30 group-hover:shadow-md transition-all duration-300 mb-4">
        {product.images?.[0]?.url ? (
          <Image
            src={product.images[0].url}
            alt={isRtl && product.nameAr ? product.nameAr : product.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 ease-out"
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
            <PlaceholderImageIcon />
          </div>
        )}

        {/* Quick add overlay — slides up from bottom */}
        <div
          className="absolute bottom-0 inset-x-0 bg-foreground/90 py-3 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out"
          onClick={e => e.preventDefault()}
        >
          <AddToCartButton
            productId={product.id}
            inStock={product.inStock !== false}
            quantityInCart={quantityInCart}
            isRtl={isRtl}
            onAddToCart={handleAddToCart}
            showQuantityBadge={false}
            variant="ghost"
            className={cn(
              'text-background font-serif text-xs tracking-widest uppercase w-full',
              'hover:text-primary hover:bg-transparent transition-colors duration-200',
              'py-0 h-auto'
            )}
            labels={{
              addToCart: isRtl ? 'أضف للسلة' : 'Add to Bag',
              addedToCart: isRtl ? 'تمت الإضافة' : 'Added',
              outOfStock: isRtl ? 'نفذت الكمية' : 'Sold Out',
              adding: isRtl ? 'جاري الإضافة...' : 'Adding...',
            }}
          />
        </div>

        {/* Badges — top corner */}
        {product.isNew && (
          <ProductBadge
            variant="new"
            isRtl={isRtl}
            size="sm"
            absolute
            position={isRtl ? 'top-right' : 'top-left'}
            className="font-serif tracking-widest uppercase bg-foreground text-background rounded-none text-[10px]"
            label={isRtl ? 'جديد' : 'New'}
          />
        )}
        {product.inStock === false && (
          <ProductBadge
            variant="soldOut"
            isRtl={isRtl}
            size="sm"
            absolute
            position={isRtl ? 'top-right' : 'top-left'}
            className="font-serif tracking-widest uppercase rounded-none text-[10px]"
          />
        )}
      </div>

      {/* Product info */}
      <div className={`text-center ${isRtl ? 'direction-rtl' : ''}`}>
        <h3 className="font-serif text-sm md:text-base text-foreground mb-1.5 group-hover:text-primary transition-colors duration-200 leading-snug">
          {isRtl && product.nameAr ? product.nameAr : product.name}
        </h3>

        <Price
          price={product.price}
          compareAtPrice={product.compareAtPrice}
          currency={currency}
          isRtl={isRtl}
          size="sm"
          showDiscount={false}
          className="justify-center font-serif text-muted-foreground"
        />
      </div>
    </Link>
  );
}
