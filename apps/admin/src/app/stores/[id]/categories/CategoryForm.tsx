'use client';

import { useState } from 'react';
import { ImageUpload } from '../../../../components/ImageUpload';
import { AITranslateMissingButton } from '../../../../components/AITranslateMissingButton';
import { apiPost } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { SizeChartSelect, type SizeChartOption } from '../../../../components/SizeChartSelect';
import { applyAiSeoSuggestion } from '../seo/language-guard';

import { Button } from '@/components/ui/Button';
import { SparkleIcon } from '@/components/SparkleIcon';
interface CategoryFormData {
  name: string;
  nameAr: string;
  slug: string;
  description: string;
  descriptionAr: string;
  image: string;
  metaTitle?: string;
  metaTitleAr?: string;
  metaDescription?: string;
  metaDescriptionAr?: string;
  metaDescriptionAeo?: string;
  metaDescriptionAeoAr?: string;
  showOnHomeStrip?: boolean;
  /** Size chart the category's products inherit; '' = none (sent as null). */
  sizeChartId?: string;
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
  /** The store is Arabic-first: the Arabic name comes first and is the required one. */
  arFirst: boolean;
  /** Tenant scope so the category cover lands under `stores/<storeId>/categories/...`. */
  storeId: string;
  /** Size-guide picker options. */
  sizeCharts: SizeChartOption[];
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
  arFirst,
  storeId,
  sizeCharts,
}: CategoryFormProps) {
  const t = useT('categories.form');
  const [seoGenerating, setSeoGenerating] = useState(false);
  const [seoMessage, setSeoMessage] = useState<string | null>(null);

  async function generateSeo(mode: 'fill-empty' | 'overwrite') {
    if (!editingId) {
      setSeoMessage(t('seoSaveFirst'));
      return;
    }
    setSeoMessage(null);
    setSeoGenerating(true);
    try {
      const { data, error } = await apiPost<{
        suggestion: {
          title: string;
          titleAr: string;
          description: string;
          descriptionAr: string;
        };
      }>(`/api/v1/stores/${storeId}/ai/seo`, { kind: 'category', id: editingId });
      if (error || !data) {
        setSeoMessage(error?.message || t('seoGenerationFailed'));
        return;
      }
      const s = data.suggestion;
      // QA P2-2: same language guard as the store SEO page, Arabic never lands in an English field.
      onFormChange(prev => applyAiSeoSuggestion(prev, s, mode).next);
      setSeoMessage(t('seoFilled'));
    } catch {
      setSeoMessage(t('seoNetworkError'));
    } finally {
      setSeoGenerating(false);
    }
  }

  const req = <span className="text-destructive-ink">{t('required')}</span>;
  const inputCls = (error?: string) =>
    `w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${error ? 'border-destructive' : 'border-border'}`;
  const englishName = (
    <div key="en">
      <label className="block text-sm font-medium text-foreground mb-1">
        {t('nameEnglish')} {!arFirst && req}
      </label>
      <input
        type="text"
        value={form.name}
        onChange={e => {
          const val = e.target.value;
          onFormChange(prev => ({
            ...prev,
            name: val,
            // Auto-generate slug only when adding, not editing; an empty English name falls back to the Arabic one.
            slug: !editingId ? slugify(val.trim() ? val : prev.nameAr) : prev.slug,
          }));
          if (formErrors.name) onFormErrorChange(prev => ({ ...prev, name: '' }));
        }}
        placeholder={t('nameEnglishPlaceholder')}
        className={inputCls(formErrors.name)}
      />
      {formErrors.name && <p className="mt-1 text-xs text-destructive-ink">{formErrors.name}</p>}
    </div>
  );
  const arabicName = (
    <div key="ar">
      <label className="block text-sm font-medium text-foreground mb-1">
        {t('nameArabic')} {arFirst && req}
      </label>
      <input
        type="text"
        lang="ar"
        dir="rtl"
        value={form.nameAr}
        onChange={e => {
          const val = e.target.value;
          onFormChange(prev => ({
            ...prev,
            nameAr: val,
            slug: !editingId && !prev.name.trim() ? slugify(val) : prev.slug,
          }));
          if (formErrors.nameAr) onFormErrorChange(prev => ({ ...prev, nameAr: '' }));
        }}
        placeholder={t('nameArabicPlaceholder')}
        className={inputCls(formErrors.nameAr)}
      />
      {formErrors.nameAr && (
        <p className="mt-1 text-xs text-destructive-ink">{formErrors.nameAr}</p>
      )}
    </div>
  );

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
          <Button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </Button>
        </div>
      </div>
      <form onSubmit={onSubmit} className="p-6 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {arFirst ? [arabicName, englishName] : [englishName, arabicName]}
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('urlSlug')} <span className="text-destructive-ink">{t('required')}</span>
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
          {formErrors.slug && (
            <p className="mt-1 text-xs text-destructive-ink">{formErrors.slug}</p>
          )}
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
            aspectRatio="1/1"
            recommendedSizeHint={t('categoryImageHint')}
          />
        </div>

        {/* Homepage category-strip visibility (default on). */}
        <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border p-4">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              {t('showOnHomeStrip')}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t('showOnHomeStripHint')}
            </span>
          </span>
          <input
            type="checkbox"
            checked={form.showOnHomeStrip ?? true}
            onChange={e => onFormChange(prev => ({ ...prev, showOnHomeStrip: e.target.checked }))}
            className="h-5 w-5 cursor-pointer accent-primary"
          />
        </label>

        {/* Size guide inherited by this category's products on the PDP (B0 Task 9). */}
        <div className="max-w-sm">
          <SizeChartSelect
            kind="category"
            storeId={storeId}
            charts={sizeCharts}
            value={form.sizeChartId ?? ''}
            onChange={v => onFormChange(prev => ({ ...prev, sizeChartId: v }))}
          />
        </div>

        {/* SEO meta — what shows up on Google + social shares for this category. */}
        <div className="rounded-lg border border-border p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">{t('seoHeading')}</h3>
              <p className="text-xs text-muted-foreground">{t('seoSubheading')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => generateSeo('fill-empty')}
                disabled={seoGenerating}
                variant="outline"
                size="sm"
                className="gap-2 font-semibold"
              >
                <SparkleIcon />
                {seoGenerating ? t('seoGenerating') : t('seoFillEmpty')}
              </Button>
              <Button
                type="button"
                onClick={() => generateSeo('overwrite')}
                disabled={seoGenerating}
                variant="outline"
                size="sm"
                className="gap-2 font-semibold"
              >
                {t('seoRegenerateAll')}
              </Button>
            </div>
          </div>
          {seoMessage && <p className="mb-2 text-xs text-muted-foreground">{seoMessage}</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                {t('metaTitleLabel', { count: (form.metaTitle ?? '').length })}
              </label>
              <input
                type="text"
                maxLength={70}
                value={form.metaTitle ?? ''}
                onChange={e => onFormChange(prev => ({ ...prev, metaTitle: e.target.value }))}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                {t('metaTitleArLabel', { count: (form.metaTitleAr ?? '').length })}
              </label>
              <input
                type="text"
                maxLength={70}
                lang="ar"
                dir="rtl"
                value={form.metaTitleAr ?? ''}
                onChange={e => onFormChange(prev => ({ ...prev, metaTitleAr: e.target.value }))}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                {t('metaDescriptionLabel', { count: (form.metaDescription ?? '').length })}
              </label>
              <textarea
                maxLength={180}
                rows={2}
                value={form.metaDescription ?? ''}
                onChange={e => onFormChange(prev => ({ ...prev, metaDescription: e.target.value }))}
                className="w-full resize-none rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                {t('metaDescriptionArLabel', { count: (form.metaDescriptionAr ?? '').length })}
              </label>
              <textarea
                maxLength={180}
                rows={2}
                lang="ar"
                dir="rtl"
                value={form.metaDescriptionAr ?? ''}
                onChange={e =>
                  onFormChange(prev => ({ ...prev, metaDescriptionAr: e.target.value }))
                }
                className="w-full resize-none rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="col-span-2">
              <p className="mb-2 text-xs text-muted-foreground">
                {t.rich('aeoIntro', {
                  b: chunks => <span className="font-medium text-foreground">{chunks}</span>,
                })}
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                {t('aeoMetaEnLabel', { count: (form.metaDescriptionAeo ?? '').length })}
              </label>
              <textarea
                maxLength={180}
                rows={2}
                value={form.metaDescriptionAeo ?? ''}
                onChange={e =>
                  onFormChange(prev => ({ ...prev, metaDescriptionAeo: e.target.value }))
                }
                className="w-full resize-none rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">
                {t('aeoMetaArLabel', { count: (form.metaDescriptionAeoAr ?? '').length })}
              </label>
              <textarea
                maxLength={180}
                rows={2}
                lang="ar"
                dir="rtl"
                value={form.metaDescriptionAeoAr ?? ''}
                onChange={e =>
                  onFormChange(prev => ({ ...prev, metaDescriptionAeoAr: e.target.value }))
                }
                className="w-full resize-none rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
        </div>

        {saveMessage && (
          <p
            className={`text-sm ${
              saveMessage.includes('success') ? 'text-success-ink' : 'text-destructive-ink'
            }`}
          >
            {saveMessage}
          </p>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
          <Button type="button" onClick={onClose} variant="outline">
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={isSaving} variant="default">
            {isSaving ? t('saving') : editingId ? t('updateCategory') : t('createCategory')}
          </Button>
        </div>
      </form>
    </div>
  );
}
