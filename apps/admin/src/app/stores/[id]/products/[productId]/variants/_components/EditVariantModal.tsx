'use client';

import { Button, Input, Label } from '@force/ui';
import { useT } from '@/i18n/useT';
import { ImageUpload } from '@/components/ImageUpload';
import type { Variant, VariantFormState } from './types';

interface EditVariantModalProps {
  variant: Variant;
  form: VariantFormState;
  onChange: (next: VariantFormState) => void;
  onCancel: () => void;
  onSubmit: () => void;
  /** Number of OTHER variants on this product. The "Apply to all" buttons
   *  only render when there are siblings to apply the value to (>= 1). */
  siblingCount?: number;
  /** Optional broadcast hook. Called when the merchant clicks "Apply to all"
   *  next to one of the three numeric fields. Implementation lives in the
   *  parent so it has access to the full variants list + the API client. */
  onApplyToAll?: (field: 'price' | 'compareAtPrice' | 'costPrice', value: string) => void;
}

export function EditVariantModal({
  variant,
  form,
  onChange,
  onCancel,
  onSubmit,
  siblingCount = 0,
  onApplyToAll,
}: EditVariantModalProps) {
  const t = useT('products.variants.variantModal');
  const showApplyAll = siblingCount > 0 && !!onApplyToAll;

  function applyAllButton(field: 'price' | 'compareAtPrice' | 'costPrice', value: string) {
    if (!showApplyAll) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return (
      <button
        type="button"
        onClick={() => onApplyToAll!(field, trimmed)}
        className="mt-1 text-[11px] font-medium text-primary hover:underline cursor-pointer text-start"
      >
        {t('applyToAll', { count: siblingCount })}
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-xl bg-card p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-foreground mb-4">
          {t('title', { title: variant.title })}
        </h3>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="variantSku">{t('skuLabel')}</Label>
              <Input
                id="variantSku"
                value={form.sku}
                onChange={e => onChange({ ...form, sku: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="variantBarcode">{t('barcodeLabel')}</Label>
              <Input
                id="variantBarcode"
                value={form.barcode}
                onChange={e => onChange({ ...form, barcode: e.target.value })}
                className="mt-1"
              />
            </div>
          </div>

          {/* Per-variant image. Sits above the price grid because merchants
              eyeball "is this the right pack?" via the picture before they
              touch any numbers. Folder hint `products` keeps R2 organized
              alongside the rest of the product media. */}
          <div>
            <Label>{t('imageLabel')}</Label>
            <ImageUpload
              value={form.imageUrl || undefined}
              onUpload={url => onChange({ ...form, imageUrl: url })}
              onRemove={() => onChange({ ...form, imageUrl: '' })}
              folder="products"
              className="mt-1"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('imageTip')}</p>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label htmlFor="variantPrice">{t('priceLabel')}</Label>
              <Input
                id="variantPrice"
                type="number"
                value={form.price}
                onChange={e => onChange({ ...form, price: e.target.value })}
                placeholder={t('pricePlaceholder')}
                className="mt-1"
              />
              {applyAllButton('price', form.price)}
            </div>
            <div>
              <Label htmlFor="variantCompareAt">{t('compareAtLabel')}</Label>
              <Input
                id="variantCompareAt"
                type="number"
                value={form.compareAtPrice}
                onChange={e => onChange({ ...form, compareAtPrice: e.target.value })}
                className="mt-1"
              />
              {applyAllButton('compareAtPrice', form.compareAtPrice)}
            </div>
            <div>
              <Label htmlFor="variantCost">{t('costLabel')}</Label>
              <Input
                id="variantCost"
                type="number"
                value={form.costPrice}
                onChange={e => onChange({ ...form, costPrice: e.target.value })}
                className="mt-1"
              />
              {applyAllButton('costPrice', form.costPrice)}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="variantInventory">{t('inventoryLabel')}</Label>
              <Input
                id="variantInventory"
                type="number"
                value={form.inventory}
                onChange={e => onChange({ ...form, inventory: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="variantWeight">{t('weightLabel')}</Label>
              <Input
                id="variantWeight"
                type="number"
                step="0.01"
                value={form.weight}
                onChange={e => onChange({ ...form, weight: e.target.value })}
                className="mt-1"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button onClick={onSubmit}>{t('submit')}</Button>
        </div>
      </div>
    </div>
  );
}
