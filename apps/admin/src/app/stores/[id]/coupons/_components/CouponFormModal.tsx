'use client';

import type { FormEvent } from 'react';
import { useT } from '@/i18n/useT';
import { BottomSheet } from '@/components/mobile/BottomSheet';
import { ScopePicker } from '../../_components/ScopePicker';
import type { CouponFormData, CouponType } from './types';

interface CustomerGroupOption {
  id: string;
  name: string;
  nameAr: string | null;
}

interface CouponFormModalProps {
  isEditing: boolean;
  formData: CouponFormData;
  onChange: (formData: CouponFormData) => void;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
  storeId: string;
  customerGroups: CustomerGroupOption[];
  /** Why the server refused the save (already in the admin language). */
  saveError?: string | null;
  onDismissError?: () => void;
}

/**
 * Create/edit coupon form. Renders inside `<BottomSheet>` so on phones
 * it slides up from the bottom with a drag handle and a sticky save bar
 * the merchant can reach with their thumb. On tablet/desktop the same
 * sheet falls back to a centred dialog so the existing UX is preserved.
 */
export function CouponFormModal({
  isEditing,
  formData,
  onChange,
  onSubmit,
  onClose,
  storeId,
  customerGroups,
  saveError,
  onDismissError,
}: CouponFormModalProps) {
  const tModal = useT('coupons.modal');
  const tForm = useT('coupons.form');
  const tType = useT('coupons.type');
  const tActions = useT('coupons.actions');
  const tTargeting = useT('coupons.targeting');

  // Form id lets the sticky footer Submit button live OUTSIDE the
  // <form> element (inside BottomSheet's footer slot) and still
  // submit the form when tapped.
  const FORM_ID = 'coupon-form';

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={isEditing ? tModal('editTitle') : tModal('createTitle')}
      footer={
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 min-h-11 border border-border text-foreground rounded-lg hover:bg-muted"
          >
            {tActions('cancel')}
          </button>
          <button
            type="submit"
            form={FORM_ID}
            className="flex-1 px-4 py-2 min-h-11 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
          >
            {isEditing ? tActions('update') : tActions('create')}
          </button>
        </div>
      }
    >
      <form id={FORM_ID} onSubmit={onSubmit} className="space-y-6">
        {saveError ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive-ink"
          >
            {saveError}
            {onDismissError ? (
              <button type="button" onClick={onDismissError} className="ms-3 underline">
                ×
              </button>
            ) : null}
          </div>
        ) : null}
        {/* Basic Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {tForm('codeLabel')}
            </label>
            <input
              type="text"
              required
              value={formData.code}
              onChange={e => onChange({ ...formData, code: e.target.value.toUpperCase() })}
              placeholder={tForm('codePlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary font-mono uppercase"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {tForm('nameLabel')}
            </label>
            <input
              type="text"
              required
              value={formData.name}
              onChange={e => onChange({ ...formData, name: e.target.value })}
              placeholder={tForm('namePlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {tForm('nameArLabel')}
            </label>
            <input
              type="text"
              lang="ar"
              dir="rtl"
              value={formData.nameAr}
              onChange={e => onChange({ ...formData, nameAr: e.target.value })}
              placeholder={tForm('nameArPlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {tForm('descriptionLabel')}
            </label>
            <input
              type="text"
              value={formData.description}
              onChange={e => onChange({ ...formData, description: e.target.value })}
              placeholder={tForm('descriptionPlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {tForm('descriptionArLabel')}
          </label>
          <input
            type="text"
            lang="ar"
            dir="rtl"
            value={formData.descriptionAr}
            onChange={e => onChange({ ...formData, descriptionAr: e.target.value })}
            placeholder={tForm('descriptionArPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>

        {/* Discount Type & Value */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {tForm('typeLabel')}
            </label>
            <select
              value={formData.type}
              onChange={e => onChange({ ...formData, type: e.target.value as CouponType })}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
            >
              <option value="percentage">{tType('percentage')}</option>
              <option value="fixed">{tType('fixed')}</option>
              <option value="free_shipping">{tType('freeShipping')}</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {formData.type === 'percentage'
                ? tForm('valuePercentageLabel')
                : tForm('valueAmountLabel')}
            </label>
            <input
              type="text"
              inputMode="decimal"
              dir="ltr"
              required
              value={formData.value}
              onChange={e => onChange({ ...formData, value: e.target.value })}
              disabled={formData.type === 'free_shipping'}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary disabled:bg-muted"
            />
          </div>
        </div>

        {/* Limits */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {tForm('minOrderLabel')}
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={formData.minOrderAmount}
              onChange={e => onChange({ ...formData, minOrderAmount: e.target.value })}
              placeholder={tForm('minOrderPlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
          {formData.type === 'percentage' && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {tForm('maxDiscountLabel')}
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={formData.maxDiscount}
                onChange={e => onChange({ ...formData, maxDiscount: e.target.value })}
                placeholder={tForm('maxDiscountPlaceholder')}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {tForm('usageLimitLabel')}
            </label>
            <input
              type="number"
              min="1"
              value={formData.usageLimit}
              onChange={e => onChange({ ...formData, usageLimit: e.target.value })}
              placeholder={tForm('usageLimitPlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {tForm('usageLimitPerUserLabel')}
            </label>
            <input
              type="number"
              min="1"
              value={formData.usageLimitPerUser}
              onChange={e => onChange({ ...formData, usageLimitPerUser: e.target.value })}
              placeholder={tForm('usageLimitPerUserPlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
        </div>

        {/* Date Range */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {tForm('startsAt')}
            </label>
            <input
              type="datetime-local"
              value={formData.startsAt}
              onChange={e => onChange({ ...formData, startsAt: e.target.value })}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {tForm('expiresAt')}
            </label>
            <input
              type="datetime-local"
              value={formData.expiresAt}
              onChange={e => onChange({ ...formData, expiresAt: e.target.value })}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
        </div>

        {/* Active Toggle */}
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="isActive"
            checked={formData.isActive}
            onChange={e => onChange({ ...formData, isActive: e.target.checked })}
            className="w-4 h-4 text-primary border-border rounded focus:ring-primary"
          />
          <label htmlFor="isActive" className="text-sm font-medium text-foreground">
            {tForm('isActiveLabel')}
          </label>
        </div>

        {/* Targeting — same shape shared with Promotion (see
            promotion.routes.ts's createSchema). Empty group/scope = "everyone,
            whole cart". */}
        <div className="border-t border-border pt-4">
          <h3 className="mb-3 text-sm font-semibold text-foreground">{tTargeting('heading')}</h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {tTargeting('customerGroup')}
              </label>
              <select
                value={formData.customerGroupId}
                onChange={e => onChange({ ...formData, customerGroupId: e.target.value })}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              >
                <option value="">{tTargeting('allCustomers')}</option>
                {customerGroups.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {tTargeting('minQuantity')}
              </label>
              <input
                type="number"
                min="1"
                value={formData.minQuantity}
                onChange={e => onChange({ ...formData, minQuantity: e.target.value })}
                placeholder={tTargeting('minQuantityPlaceholder')}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          </div>

          <label className="mt-4 flex items-center gap-3">
            <input
              type="checkbox"
              id="firstOrderOnly"
              checked={formData.firstOrderOnly}
              onChange={e => onChange({ ...formData, firstOrderOnly: e.target.checked })}
              className="w-4 h-4 text-primary border-border rounded focus:ring-primary"
            />
            <span className="text-sm font-medium text-foreground">
              {tTargeting('firstOrderOnlyLabel')}
            </span>
          </label>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <ScopePicker
              storeId={storeId}
              kind="products"
              value={formData.scopeProductIds}
              onChange={ids => onChange({ ...formData, scopeProductIds: ids })}
              label={tTargeting('scopeProducts')}
              searchPlaceholder={tTargeting('scopeProductsPlaceholder')}
              emptyHint={tTargeting('scopeEmptyHint')}
              removeLabel={tTargeting('scopeRemove')}
            />
            <ScopePicker
              storeId={storeId}
              kind="categories"
              value={formData.scopeCategoryIds}
              onChange={ids => onChange({ ...formData, scopeCategoryIds: ids })}
              label={tTargeting('scopeCategories')}
              searchPlaceholder={tTargeting('scopeCategoriesPlaceholder')}
              emptyHint={tTargeting('scopeEmptyHint')}
              removeLabel={tTargeting('scopeRemove')}
            />
          </div>
        </div>
      </form>
    </BottomSheet>
  );
}
