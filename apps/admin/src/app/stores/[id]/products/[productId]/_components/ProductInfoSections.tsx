'use client';

import Image from 'next/image';
import { useLocale } from 'next-intl';
import { Badge } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { formatPrice, intlLocaleForUi } from '../../../../../../lib/format';

interface Product {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  description?: string;
  descriptionAr?: string;
  price: number;
  compareAtPrice?: number;
  costPrice?: number;
  sku?: string;
  barcode?: string;
  inventory: number;
  /** Variant-aware stock total from the API (variant sum for variant products, else `inventory`). */
  totalInventory?: number;
  hasVariants?: boolean;
  lowStockThreshold: number;
  status: string;
  images: { id: string; url: string; alt?: string; position: number }[];
}

interface ProductInfoSectionsProps {
  product: Product;
  statusBadge: React.ReactNode;
  fallbackSku: string;
}

export function ProductInfoSections({
  product,
  statusBadge,
  fallbackSku,
}: ProductInfoSectionsProps) {
  const tSections = useT('products.detail.sections');
  const tFields = useT('products.detail.fields');

  // `totalInventory` is the API's variant-aware stock (variant sum for a
  // variant product, else `inventory`). Optional so an older cached payload
  // still renders.
  const onHand = product.totalInventory ?? product.inventory;

  return (
    <>
      <div className="rounded-xl border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          {tSections('productDetails')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium text-muted-foreground">{tFields('name')}</label>
            <p className="mt-1 text-foreground">{product.name}</p>
          </div>
          {product.nameAr && (
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                {tFields('nameAr')}
              </label>
              <p className="mt-1 text-foreground" lang="ar" dir="rtl">
                {product.nameAr}
              </p>
            </div>
          )}
          <div>
            <label className="text-sm font-medium text-muted-foreground">{tFields('slug')}</label>
            <p className="mt-1 text-foreground font-mono text-sm">{product.slug}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-muted-foreground">{tFields('status')}</label>
            <div className="mt-1">{statusBadge}</div>
          </div>
        </div>
        {product.description && (
          <div className="mt-4">
            <label className="text-sm font-medium text-muted-foreground">
              {tFields('description')}
            </label>
            <p className="mt-1 text-foreground">{product.description}</p>
          </div>
        )}
        {product.descriptionAr && (
          <div className="mt-4">
            <label className="text-sm font-medium text-muted-foreground">
              {tFields('descriptionAr')}
            </label>
            <p className="mt-1 text-foreground" lang="ar" dir="rtl">
              {product.descriptionAr}
            </p>
          </div>
        )}
      </div>

      <div className="rounded-xl border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('pricing')}</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-sm font-medium text-muted-foreground">{tFields('price')}</label>
            <p className="mt-1 text-2xl font-bold text-foreground">{formatPrice(product.price)}</p>
          </div>
          {product.compareAtPrice && (
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                {tFields('compareAtPrice')}
              </label>
              <p className="mt-1 text-lg text-muted-foreground line-through">
                {formatPrice(product.compareAtPrice)}
              </p>
            </div>
          )}
          {product.costPrice && (
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                {tFields('costPrice')}
              </label>
              <p className="mt-1 text-lg text-foreground">{formatPrice(product.costPrice)}</p>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('inventory')}</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-sm font-medium text-muted-foreground">{tFields('sku')}</label>
            <p className="mt-1 text-foreground font-mono">{product.sku || fallbackSku}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-muted-foreground">
              {tFields('barcode')}
            </label>
            <p className="mt-1 text-foreground font-mono">{product.barcode || fallbackSku}</p>
          </div>
          <div>
            <label className="text-sm font-medium text-muted-foreground">{tFields('stock')}</label>
            {/* Variant products carry their stock on the variants; the
                product-level `inventory` column is unused for them and had
                drifted negative, which is how this panel came to read
                "-16 in stock". Resolve against the API's variant-aware
                `totalInventory`, mirroring ProductsTable.tsx (~:216).
                `<= 0`, not `=== 0`: a non-variant product can hold a real
                negative (backorder debt) and that must read out-of-stock,
                not low-stock amber. */}
            <p
              className={`mt-1 text-lg font-semibold ${
                onHand <= 0
                  ? 'text-destructive-ink'
                  : onHand <= product.lowStockThreshold
                    ? 'text-warning-ink'
                    : 'text-success-ink'
              }`}
            >
              {tFields('stockInStock', { count: onHand })}
            </p>
          </div>
        </div>
      </div>

      {product.images && product.images.length > 0 && (
        <div className="rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('images')}</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {product.images.map(image => (
              <div
                key={image.id}
                className="aspect-square rounded-lg overflow-hidden border bg-muted"
              >
                <Image
                  src={image.url}
                  alt={image.alt || product.name}
                  width={300}
                  height={300}
                  className="h-full w-full object-cover"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

interface ProductSidebarProps {
  product: {
    categories: {
      categoryId: string;
      category: { id: string; name: string; nameAr?: string | null };
    }[];
    tags: { tagId: string; tag: { id: string; name: string; nameAr?: string | null } }[];
    isFeatured: boolean;
    isNew: boolean;
    trackInventory: boolean;
    createdAt: string;
    updatedAt: string;
  };
}

export function ProductSidebar({ product }: ProductSidebarProps) {
  const isAr = useLocale() === 'ar';
  const tSections = useT('products.detail.sections');
  const tFields = useT('products.detail.fields');

  return (
    <>
      {product.categories && product.categories.length > 0 && (
        <div className="rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('categories')}</h2>
          <div className="flex flex-wrap gap-2">
            {product.categories.map(c => (
              <Badge key={c.categoryId || c.category?.id} variant="secondary">
                {(isAr && c.category?.nameAr) || c.category?.name || c.categoryId}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {product.tags && product.tags.length > 0 && (
        <div className="rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('tags')}</h2>
          <div className="flex flex-wrap gap-2">
            {product.tags.map(tg => (
              <Badge key={tg.tagId || tg.tag?.id} variant="outline">
                {tg.tag?.nameAr ? `${tg.tag.name} · ${tg.tag.nameAr}` : tg.tag?.name || tg.tagId}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('flags')}</h2>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{tFields('featured')}</span>
            <Badge variant={product.isFeatured ? 'default' : 'secondary'}>
              {product.isFeatured ? tFields('yes') : tFields('no')}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{tFields('newArrival')}</span>
            <Badge variant={product.isNew ? 'default' : 'secondary'}>
              {product.isNew ? tFields('yes') : tFields('no')}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{tFields('trackInventory')}</span>
            <Badge variant={product.trackInventory ? 'default' : 'secondary'}>
              {product.trackInventory ? tFields('yes') : tFields('no')}
            </Badge>
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('timestamps')}</h2>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{tFields('created')}</span>
            <span className="text-foreground">
              {new Date(product.createdAt).toLocaleDateString(intlLocaleForUi(), {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{tFields('updated')}</span>
            <span className="text-foreground">
              {new Date(product.updatedAt).toLocaleDateString(intlLocaleForUi(), {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
