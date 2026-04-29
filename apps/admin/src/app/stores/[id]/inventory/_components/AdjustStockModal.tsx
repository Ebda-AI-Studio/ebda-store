'use client';

import { ADJUSTMENT_TYPES, type ProductInventory } from './types';
import { useT } from '@/i18n/useT';
import { BottomSheet } from '@/components/mobile/BottomSheet';

interface AdjustStockModalProps {
  product: ProductInventory;
  adjustType: string;
  adjustQuantity: string;
  adjustReason: string;
  saving: boolean;
  onTypeChange: (value: string) => void;
  onQuantityChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

const REMOVE_TYPES = ['manual_remove', 'damage'];

/**
 * Modal that adjusts a product's stock. The parent owns the controlled
 * form state and handles persistence plus re-fetching on success.
 */
export function AdjustStockModal({
  product,
  adjustType,
  adjustQuantity,
  adjustReason,
  saving,
  onTypeChange,
  onQuantityChange,
  onReasonChange,
  onClose,
  onSubmit,
}: AdjustStockModalProps) {
  const t = useT('inventory.adjust');
  const tTypes = useT('inventory.adjustTypes');

  const parsedQty = parseInt(adjustQuantity || '0');
  const newStock = REMOVE_TYPES.includes(adjustType)
    ? Math.max(0, product.inventory - parsedQty)
    : product.inventory + parsedQty;

  const FORM_ID = 'adjust-stock-form';

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={t('title')}
      footer={
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 min-h-11 text-foreground border border-border rounded-lg hover:bg-muted"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            form={FORM_ID}
            disabled={saving || !adjustQuantity}
            className="px-4 py-2 min-h-11 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            )}
            {t('apply')}
          </button>
        </div>
      }
    >
      <form id={FORM_ID} onSubmit={onSubmit} className="space-y-4">
        <div className="bg-muted rounded-lg p-4">
          <p className="font-medium text-foreground">{product.name}</p>
          <p className="text-sm text-muted-foreground">
            {t('currentStock', { count: product.inventory })}
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-2">{t('typeLabel')}</label>
          <select
            value={adjustType}
            onChange={e => onTypeChange(e.target.value)}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          >
            {ADJUSTMENT_TYPES.map(type => (
              <option key={type.value} value={type.value}>
                {tTypes(type.value)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {t('quantityLabel')} <span className="text-destructive">*</span>
          </label>
          <input
            type="number"
            min="1"
            value={adjustQuantity}
            onChange={e => onQuantityChange(e.target.value)}
            placeholder={t('quantityPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            required
          />
          {adjustQuantity && (
            <p className="text-sm text-muted-foreground mt-1">
              {t('newStockPreview')} <span className="font-medium">{newStock}</span>
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {t('reasonLabel')}
          </label>
          <input
            type="text"
            value={adjustReason}
            onChange={e => onReasonChange(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
      </form>
    </BottomSheet>
  );
}
