'use client';

import { useT } from '@/i18n/useT';
import { BottomSheet } from '@/components/mobile/BottomSheet';
import type { ShippingZone } from './ShippingZonesTable';

export interface ZoneFormData {
  name: string;
  nameAr: string;
  areas: string;
  areasAr: string;
  deliveryFee: string;
  freeShippingThreshold: string;
  estimatedDaysMin: string;
  estimatedDaysMax: string;
  isActive: boolean;
}

interface ShippingZoneFormModalProps {
  editingZone: ShippingZone | null;
  formData: ZoneFormData;
  saving: boolean;
  onChange: (next: ZoneFormData) => void;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  onAddAllGovernorates: () => void;
}

export function ShippingZoneFormModal({
  editingZone,
  formData,
  saving,
  onChange,
  onClose,
  onSubmit,
  onAddAllGovernorates,
}: ShippingZoneFormModalProps) {
  const t = useT('shipping.modal');

  const FORM_ID = 'shipping-zone-form';

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={editingZone ? t('editTitle') : t('newTitle')}
      footer={
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 min-h-11 text-foreground border border-border rounded-lg hover:bg-muted transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            form={FORM_ID}
            disabled={saving}
            className="px-4 py-2 min-h-11 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving && (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            )}
            {editingZone ? t('updateZone') : t('createZone')}
          </button>
        </div>
      }
    >
      <form id={FORM_ID} onSubmit={onSubmit} className="space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('zoneNameLabel')} <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={e => onChange({ ...formData, name: e.target.value })}
              placeholder={t('zoneNamePlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('zoneNameArLabel')}
            </label>
            <input
              type="text"
              value={formData.nameAr}
              onChange={e => onChange({ ...formData, nameAr: e.target.value })}
              placeholder={t('zoneNameArPlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              lang="ar"
              dir="rtl"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-muted-foreground">
              {t('areasLabel')} <span className="text-destructive">*</span>
            </label>
            <button
              type="button"
              onClick={onAddAllGovernorates}
              className="text-xs text-primary hover:text-primary/90"
            >
              {t('addAllKuwaitGovernorates')}
            </button>
          </div>
          <textarea
            value={formData.areas}
            onChange={e => onChange({ ...formData, areas: e.target.value })}
            placeholder={t('areasPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            rows={2}
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('areasArLabel')}
          </label>
          <textarea
            value={formData.areasAr}
            onChange={e => onChange({ ...formData, areasAr: e.target.value })}
            placeholder={t('areasArPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            rows={2}
            lang="ar"
            dir="rtl"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('deliveryFeeLabel')} <span className="text-destructive">*</span>
            </label>
            <input
              type="number"
              step="0.001"
              min="0"
              value={formData.deliveryFee}
              onChange={e => onChange({ ...formData, deliveryFee: e.target.value })}
              placeholder={t('deliveryFeePlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('freeShippingLabel')}
            </label>
            <input
              type="number"
              step="0.001"
              min="0"
              value={formData.freeShippingThreshold}
              onChange={e => onChange({ ...formData, freeShippingThreshold: e.target.value })}
              placeholder={t('freeShippingPlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('estimatedDaysLabel')}
          </label>
          <div className="grid grid-cols-2 gap-4">
            <input
              type="number"
              min="1"
              value={formData.estimatedDaysMin}
              onChange={e => onChange({ ...formData, estimatedDaysMin: e.target.value })}
              placeholder={t('estimatedDaysMinPlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            />
            <input
              type="number"
              min="1"
              value={formData.estimatedDaysMax}
              onChange={e => onChange({ ...formData, estimatedDaysMax: e.target.value })}
              placeholder={t('estimatedDaysMaxPlaceholder')}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={formData.isActive}
              onChange={e => onChange({ ...formData, isActive: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary/30 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
          </label>
          <span className="text-sm text-foreground">{t('activeLabel')}</span>
        </div>
      </form>
    </BottomSheet>
  );
}
