'use client';

import { useT } from '@/i18n/useT';
import { BottomSheet } from '@/components/mobile/BottomSheet';
import { COMMON_TAX_TYPES, type RateFormData, type TaxRate, type TaxTemplate } from './types';

import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
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
          <Button type="button" onClick={onClose} variant="outline">
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            disabled={saving}
            variant="default"
            className="gap-2"
          >
            {saving && (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            )}
            {editingRate ? t('update') : t('create')}
          </Button>
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
                <Button
                  key={template.name}
                  type="button"
                  onClick={() => onApplyTemplate(template)}
                  variant="secondary"
                  size="sm"
                >
                  {template.name} ({template.rate}%)
                </Button>
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
              className={FIELD_CLASSES}
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
              className={FIELD_CLASSES}
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
              className={`${FIELD_CLASSES} w-32`}
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
