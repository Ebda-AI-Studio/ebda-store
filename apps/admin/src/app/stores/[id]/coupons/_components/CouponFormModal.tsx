'use client';

import type { FormEvent } from 'react';
import { useT } from '@/i18n/useT';
import type { CouponFormData, CouponType } from './types';

interface CouponFormModalProps {
  isEditing: boolean;
  formData: CouponFormData;
  onChange: (formData: CouponFormData) => void;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
}

/**
 * Modal with the create/edit coupon form.
 */
export function CouponFormModal({
  isEditing,
  formData,
  onChange,
  onSubmit,
  onClose,
}: CouponFormModalProps) {
  const tModal = useT('coupons.modal');
  const tForm = useT('coupons.form');
  const tType = useT('coupons.type');
  const tActions = useT('coupons.actions');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b sticky top-0 bg-card">
          <h2 className="text-xl font-bold">
            {isEditing ? tModal('editTitle') : tModal('createTitle')}
          </h2>
        </div>

        <form onSubmit={onSubmit} className="p-6 space-y-6">
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
                type="number"
                required
                min="0"
                max={formData.type === 'percentage' ? 100 : undefined}
                value={formData.value}
                onChange={e => onChange({ ...formData, value: parseFloat(e.target.value) || 0 })}
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
                step="0.001"
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
                  step="0.001"
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

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-border text-foreground rounded-lg hover:bg-muted"
            >
              {tActions('cancel')}
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90"
            >
              {isEditing ? tActions('update') : tActions('create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
