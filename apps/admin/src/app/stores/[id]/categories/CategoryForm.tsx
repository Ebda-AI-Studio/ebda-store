'use client';

import { ImageUpload } from '../../../../components/ImageUpload';
import { AITranslateMissingButton } from '../../../../components/AITranslateMissingButton';
import { useT } from '@/i18n/useT';

interface CategoryFormData {
  name: string;
  nameAr: string;
  slug: string;
  description: string;
  descriptionAr: string;
  image: string;
}

interface CategoryFormProps {
  editingId: string | null;
  form: CategoryFormData;
  formErrors: Record<string, string>;
  isSaving: boolean;
  saveMessage: string | null;
  onFormChange: (updater: (prev: CategoryFormData) => CategoryFormData) => void;
  onFormErrorChange: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
  slugify: (text: string) => string;
  /** Tenant scope so the category cover lands under `stores/<storeId>/categories/...`. */
  storeId: string;
}

export type { CategoryFormData };

export function CategoryForm({
  editingId,
  form,
  formErrors,
  isSaving,
  saveMessage,
  onFormChange,
  onFormErrorChange,
  onSubmit,
  onClose,
  slugify,
  storeId,
}: CategoryFormProps) {
  const t = useT('categories.form');
  return (
    <div className="mb-6 rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <h2 className="font-semibold text-foreground">
          {editingId ? t('editTitle') : t('addTitle')}
        </h2>
        <div className="flex items-center gap-3">
          <AITranslateMissingButton
            storeId={storeId}
            pairs={[
              {
                key: 'name',
                en: form.name,
                ar: form.nameAr,
                kind: 'category-name',
                onEnFilled: v => onFormChange(prev => ({ ...prev, name: v })),
                onArFilled: v => onFormChange(prev => ({ ...prev, nameAr: v })),
              },
              {
                key: 'description',
                en: form.description,
                ar: form.descriptionAr,
                kind: 'category-description',
                onEnFilled: v => onFormChange(prev => ({ ...prev, description: v })),
                onArFilled: v => onFormChange(prev => ({ ...prev, descriptionAr: v })),
              },
            ]}
          />
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-muted-foreground"
            aria-label={t('close')}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>
      <form onSubmit={onSubmit} className="p-6 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t('nameEnglish')} <span className="text-destructive">{t('required')}</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={e => {
                const val = e.target.value;
                onFormChange(prev => ({
                  ...prev,
                  name: val,
                  // Auto-generate slug only when adding, not editing
                  slug: !editingId ? slugify(val) : prev.slug,
                }));
                if (formErrors.name) onFormErrorChange(prev => ({ ...prev, name: '' }));
              }}
              placeholder={t('nameEnglishPlaceholder')}
              className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${formErrors.name ? 'border-destructive' : 'border-border'}`}
            />
            {formErrors.name && <p className="mt-1 text-xs text-destructive">{formErrors.name}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t('nameArabic')}
            </label>
            <input
              type="text"
              lang="ar"
              dir="rtl"
              value={form.nameAr}
              onChange={e => onFormChange(prev => ({ ...prev, nameAr: e.target.value }))}
              placeholder={t('nameArabicPlaceholder')}
              className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('urlSlug')} <span className="text-destructive">{t('required')}</span>
          </label>
          <input
            type="text"
            value={form.slug}
            onChange={e => {
              onFormChange(prev => ({ ...prev, slug: slugify(e.target.value) }));
              if (formErrors.slug) onFormErrorChange(prev => ({ ...prev, slug: '' }));
            }}
            placeholder={t('urlSlugPlaceholder')}
            className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${formErrors.slug ? 'border-destructive' : 'border-border'}`}
          />
          {formErrors.slug && <p className="mt-1 text-xs text-destructive">{formErrors.slug}</p>}
          <p className="mt-1 text-xs text-muted-foreground">{t('urlSlugHint')}</p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t('description')}
            </label>
            <textarea
              value={form.description}
              onChange={e => onFormChange(prev => ({ ...prev, description: e.target.value }))}
              placeholder={t('descriptionPlaceholder')}
              rows={3}
              className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t('descriptionArabic')}
            </label>
            <textarea
              lang="ar"
              dir="rtl"
              value={form.descriptionAr}
              onChange={e => onFormChange(prev => ({ ...prev, descriptionAr: e.target.value }))}
              placeholder={t('descriptionArabicPlaceholder')}
              rows={3}
              className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('categoryImage')}
          </label>
          <ImageUpload
            value={form.image || undefined}
            onUpload={url => onFormChange(prev => ({ ...prev, image: url }))}
            onRemove={() => onFormChange(prev => ({ ...prev, image: '' }))}
            folder="categories"
            storeId={storeId}
            label={t('uploadCategoryImage')}
          />
        </div>

        {saveMessage && (
          <p
            className={`text-sm ${
              saveMessage.includes('success') ? 'text-success' : 'text-destructive'
            }`}
          >
            {saveMessage}
          </p>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-foreground border border-border rounded-lg hover:bg-muted"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="px-6 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
          >
            {isSaving ? t('saving') : editingId ? t('updateCategory') : t('createCategory')}
          </button>
        </div>
      </form>
    </div>
  );
}
