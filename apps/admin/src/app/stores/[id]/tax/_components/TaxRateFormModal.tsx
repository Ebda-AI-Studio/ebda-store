'use client';

import { useT } from '@/i18n/useT';
import { BottomSheet } from '@/components/mobile/BottomSheet';
import { COMMON_TAX_TYPES, type RateFormData, type TaxRate, type TaxTemplate } from './types';

interface TaxRateFormModalProps {
  editingRate: TaxRate | null;
  formData: RateFormData;
  saving: boolean;
  onFormChange: (patch: Partial<RateFormData>) => void;
  onApplyTemplate: (template: TaxTemplate) => void;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

/**
 * Modal for creating or editing a tax rate. Receives controlled form state
 * and delegates persistence to the parent via `onSubmit`.
 */
export function TaxRateFormModal({
  editingRate,
  formData,
  saving,
  onFormChange,
  onApplyTemplate,
  onClose,
  onSubmit,
}: TaxRateFormModalProps) {
  const t = useT('tax.form');
  const FORM_ID = 'tax-rate-form';

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={editingRate ? t('editTitle') : t('newTitle')}
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
            className="px-4 py-2 min-h-11 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving && (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            )}
            {editingRate ? t('update') : t('create')}
          </button>
        </div>
      }
    >
      <form id={FORM_ID} onSubmit={onSubmit} className="space-y-6">
        {!editingRate && (
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('templates.label')}
            </label>
            <div className="flex flex-wrap gap-2">
              {COMMON_TAX_TYPES.map(template => (
                <button
                  key={template.name}
                  type="button"
                  onClick={() => onApplyTemplate(template)}
                  className="px-3 py-1.5 bg-muted text-foreground rounded-lg text-sm hover:bg-muted/80 transition-colors"
                >
                  {template.name} ({template.rate}%)
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('name.label')} <span className="text-destructive-ink">*</span>
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={e => onFormChange({ name: e.target.value })}
              placeholder={t('name.placeholder')}
              className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('nameAr.label')}
            </label>
            <input
              type="text"
              value={formData.nameAr}
              onChange={e => onFormChange({ nameAr: e.target.value })}
              placeholder={t('nameAr.placeholder')}
              className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              lang="ar"
              dir="rtl"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('rate.label')} <span className="text-destructive-ink">*</span>
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={formData.rate}
              onChange={e => onFormChange({ rate: e.target.value })}
              placeholder={t('rate.placeholder')}
              className="w-32 px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              required
            />
            <span className="text-muted-foreground">%</span>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={formData.isActive}
                onChange={e => onFormChange({ isActive: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary/30 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
            </label>
            <span className="text-sm text-foreground">{t('active.label')}</span>
          </div>
        </div>
      </form>
    </BottomSheet>
  );
}
