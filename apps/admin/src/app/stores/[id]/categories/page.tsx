'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { recommendedSizeTextForTemplate, slugify, type TemplateId } from '@ebda/shared';
import { arrayMove } from '@dnd-kit/sortable';
import { type DragEndEvent } from '@dnd-kit/core';
import { AdminLayout } from '../../../../components/AdminLayout';
import { ImageUpload } from '../../../../components/ImageUpload';
import { SearchInput } from '../../../../components/SearchInput';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../lib/api';
import { textFieldValue } from '../../../../lib/form-text';
import { CategoryForm, type CategoryFormData } from './CategoryForm';
import { CategoryTable, type Category } from './CategoryTable';
import { CategorySuggestionPanel } from './CategorySuggestionPanel';
import { useT } from '@/i18n/useT';
import { RowActions } from '../../../../components/RowActions';
import type { SizeChartOption } from '../../../../components/SizeChartSelect';
import { FIELD_CLASSES } from '@/components/ui/tokens';

const emptyForm: CategoryFormData = {
  name: '',
  nameAr: '',
  slug: '',
  description: '',
  descriptionAr: '',
  image: '',
  metaTitle: '',
  metaTitleAr: '',
  metaDescription: '',
  metaDescriptionAr: '',
  metaDescriptionAeo: '',
  metaDescriptionAeoAr: '',
  showOnHomeStrip: true,
  sizeChartId: '',
};

export default function StoreCategoriesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('categories.page');
  const tForm = useT('categories.form');
  const tCommon = useT('common');
  const tTags = useT('tags.page');

  const [categories, setCategories] = useState<Category[]>([]);
  // Size-guide picker options for the category form (B0 Task 9).
  const [sizeCharts, setSizeCharts] = useState<SizeChartOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Debounced search term — client-side filter over category name (EN + AR).
  const [search, setSearch] = useState('');

  // Form state for add/edit
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CategoryFormData>(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  // Scroll target so clicking Edit on a row lower in the list brings the
  // add/edit form (rendered at the top) into view instead of leaving the
  // merchant scrolled down wondering where it went.
  const formRef = useRef<HTMLDivElement | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Delete state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const { success: toastSuccess, error: showError } = useToast();

  /** Template of the store — used to show per-theme recommended upload sizes. */
  const [storeTemplate, setStoreTemplate] = useState<TemplateId | undefined>();
  /** The store's default language decides which name is required (same rule as the product form, UX:PN-2). */
  const [storeLang, setStoreLang] = useState<'ar' | 'en' | null>(null);
  const uiLocale = useLocale();
  const arFirst = (storeLang ?? (uiLocale === 'ar' ? 'ar' : 'en')) === 'ar';

  // Best Sellers virtual category cover. Lives on the Store row, not on
  // a Category row — so it gets its own tiny GET/PUT pair instead of
  // riding the categories CRUD.
  const [bestSellersImage, setBestSellersImage] = useState<string | null>(null);
  const [savingBestSellersImage, setSavingBestSellersImage] = useState(false);

  // Show the virtual Best Sellers tile in the homepage category strip. Lives on
  // the StoreTheme JSON (`showBestSellersTile`, default true) — the tile has no
  // Category row, so the per-category showOnHomeStrip flag can't reach it. The
  // storefront omits the tile when this is false; the Best Sellers carousel +
  // listing page are unaffected.
  const [showBestSellersTile, setShowBestSellersTile] = useState(true);
  const [savingShowBestSellersTile, setSavingShowBestSellersTile] = useState(false);

  // Merchant-configurable product count unit label shown on category cards
  // (e.g. "4 pieces" / "4 قطعة"). Stored on StoreTheme JSON (`categoryCountUnit`).
  // Defaults are "pieces" (EN) and "قطعة" (AR) — same as the storefront fallback.
  const [countUnitEn, setCountUnitEn] = useState('pieces');
  const [countUnitAr, setCountUnitAr] = useState('قطعة');
  const [savingCountUnit, setSavingCountUnit] = useState(false);

  const saveCountUnit = useCallback(
    async (en: string, ar: string) => {
      if (!storeId) return;
      setSavingCountUnit(true);
      try {
        const { error: apiError } = await apiPut(`/api/v1/stores/${storeId}/theme`, {
          categoryCountUnit: { en: en.trim() || 'pieces', ar: ar.trim() || 'قطعة' },
        });
        if (apiError) {
          showError(t('errorTitle'), apiError.message ?? '');
          return;
        }
        toastSuccess(t('countUnitSaved'));
      } finally {
        setSavingCountUnit(false);
      }
    },
    [storeId, showError, toastSuccess, t]
  );

  const saveShowBestSellersTile = useCallback(
    async (next: boolean) => {
      if (!storeId) return;
      const previous = showBestSellersTile;
      setShowBestSellersTile(next); // optimistic
      setSavingShowBestSellersTile(true);
      try {
        // Server shallow-merges theme — send only the key this surface owns.
        const { error: apiError } = await apiPut(`/api/v1/stores/${storeId}/theme`, {
          showBestSellersTile: next,
        });
        if (apiError) {
          setShowBestSellersTile(previous); // revert on failure
          showError(t('errorTitle'), apiError.message ?? '');
          return;
        }
        toastSuccess(next ? t('bestSellersTileShown') : t('bestSellersTileHidden'));
      } finally {
        setSavingShowBestSellersTile(false);
      }
    },
    [storeId, showBestSellersTile, showError, toastSuccess, t]
  );

  const fetchBestSellersImage = useCallback(async () => {
    if (!storeId) return;
    const { data } = await apiGet<{ image: string | null }>(
      `/api/v1/stores/${storeId}/categories/best-sellers-image`
    );
    setBestSellersImage(data?.image ?? null);
  }, [storeId]);

  const saveBestSellersImage = useCallback(
    async (image: string | null) => {
      if (!storeId) return;
      setSavingBestSellersImage(true);
      try {
        const { error: apiError } = await apiPut(
          `/api/v1/stores/${storeId}/categories/best-sellers-image`,
          { image }
        );
        if (apiError) {
          showError(t('errorTitle'), apiError.message ?? '');
          return;
        }
        setBestSellersImage(image);
        toastSuccess(image ? t('bestSellersCoverUpdated') : t('bestSellersCoverRemoved'));
      } finally {
        setSavingBestSellersImage(false);
      }
    },
    [storeId, showError, toastSuccess, t]
  );

  const fetchCategories = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<{ categories: Category[] }>(
        `/api/v1/stores/${storeId}/categories`
      );
      if (apiError) {
        setError(apiError.message || t('fetchFailed'));
      } else {
        setCategories(data?.categories || []);
      }
    } catch {
      setError(t('connectionError'));
    } finally {
      setIsLoading(false);
    }
  }, [storeId, t]);

  // Client-side filter: match category name (EN or AR), case-insensitive.
  const filteredCategories = useMemo(() => {
    if (!search.trim()) return categories;
    const q = search.toLowerCase();
    return categories.filter(
      c => c.name.toLowerCase().includes(q) || (c.nameAr ?? '').toLowerCase().includes(q)
    );
  }, [categories, search]);

  // Drag-to-reorder. Persist the new order after each drag; revert + refetch on
  // failure. Reorder is only offered when no search filter is active (so the
  // visible index == the real canonical index).
  const [reordering, setReordering] = useState(false);
  const persistOrder = useCallback(
    async (ordered: Category[]) => {
      if (!storeId) return;
      setReordering(true);
      try {
        const { error: apiError } = await apiPut(`/api/v1/stores/${storeId}/categories/reorder`, {
          orderedIds: ordered.map(c => c.id),
        });
        if (apiError) {
          showError(t('errorTitle'), apiError.message ?? '');
          fetchCategories(); // revert optimistic order to the server's truth
        }
      } finally {
        setReordering(false);
      }
    },
    [storeId, showError, fetchCategories, t]
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      setCategories(prev => {
        const oldIndex = prev.findIndex(c => c.id === active.id);
        const newIndex = prev.findIndex(c => c.id === over.id);
        const next = arrayMove(prev, oldIndex, newIndex);
        void persistOrder(next);
        return next;
      });
    },
    [persistOrder]
  );

  useEffect(() => {
    fetchCategories();
    fetchBestSellersImage();
    if (storeId) {
      apiGet<{ sizeCharts: SizeChartOption[] }>(`/api/v1/stores/${storeId}/size-charts`)
        .then(({ data }) => setSizeCharts(data?.sizeCharts ?? []))
        .catch(() => {
          // non-critical — the picker just lists no charts
        });
    }
    // Fetch store template (upload-size hint) + the Best Sellers tile flag
    // + the category count unit label (non-critical). All ride the same store GET.
    if (storeId) {
      apiGet<{
        store: {
          template?: TemplateId;
          settings?: { defaultLanguage?: string } | null;
          theme?: {
            showBestSellersTile?: boolean;
            categoryCountUnit?: { en: string; ar: string };
          };
        };
      }>(`/api/v1/admin/stores/${storeId}`)
        .then(({ data }) => {
          if (data?.store?.template) setStoreTemplate(data.store.template);
          const lang = data?.store?.settings?.defaultLanguage;
          if (lang === 'ar' || lang === 'en') setStoreLang(lang);
          // Default true — only an explicit false hides the tile.
          setShowBestSellersTile(data?.store?.theme?.showBestSellersTile !== false);
          // Populate count unit fields from saved theme (fall back to defaults).
          const saved = data?.store?.theme?.categoryCountUnit;
          if (saved?.en) setCountUnitEn(saved.en);
          if (saved?.ar) setCountUnitAr(saved.ar);
        })
        .catch(() => {
          // non-critical — falls back to base recommended size + tile shown
        });
    }
  }, [fetchCategories, fetchBestSellersImage, storeId]);

  // Bring the form into view whenever it opens or switches between add/edit.
  useEffect(() => {
    if (showForm) {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showForm, editingId]);

  function openAddForm() {
    setEditingId(null);
    setForm(emptyForm);
    setFormErrors({});
    setSaveMessage(null);
    setShowForm(true);
  }

  function openEditForm(cat: Category) {
    setEditingId(cat.id);
    setForm({
      name: cat.name,
      nameAr: cat.nameAr || '',
      slug: cat.slug,
      description: cat.description || '',
      descriptionAr: cat.descriptionAr || '',
      image: cat.image || '',
      metaTitle: (cat as Category & { metaTitle?: string }).metaTitle || '',
      metaTitleAr: (cat as Category & { metaTitleAr?: string }).metaTitleAr || '',
      metaDescription: (cat as Category & { metaDescription?: string }).metaDescription || '',
      metaDescriptionAr: (cat as Category & { metaDescriptionAr?: string }).metaDescriptionAr || '',
      metaDescriptionAeo:
        (cat as Category & { metaDescriptionAeo?: string }).metaDescriptionAeo || '',
      metaDescriptionAeoAr:
        (cat as Category & { metaDescriptionAeoAr?: string }).metaDescriptionAeoAr || '',
      showOnHomeStrip: (cat as Category & { showOnHomeStrip?: boolean }).showOnHomeStrip ?? true,
      sizeChartId: (cat as Category & { sizeChartId?: string | null }).sizeChartId ?? '',
    });
    setFormErrors({});
    setSaveMessage(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
    setFormErrors({});
    setSaveMessage(null);
  }

  function validateForm() {
    const errors: Record<string, string> = {};
    // An Arabic-first store requires the Arabic name; the English one is optional (and the reverse).
    if (arFirst ? !form.nameAr.trim() : !form.name.trim())
      errors[arFirst ? 'nameAr' : 'name'] = tForm('errorNameRequired');
    if (!form.slug.trim()) {
      errors.slug = tForm('errorSlugRequired');
    } else if (!/^[a-z0-9\u0600-\u06FF]+(?:-[a-z0-9\u0600-\u06FF]+)*$/.test(form.slug)) {
      errors.slug = tForm('errorSlugInvalid');
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateForm()) return;

    setIsSaving(true);
    setSaveMessage(null);
    try {
      const isEditing = !!editingId;
      const intent = isEditing ? 'update' : 'create';
      const endpoint = isEditing
        ? `/api/v1/stores/${storeId}/categories/${editingId}`
        : `/api/v1/stores/${storeId}/categories`;

      const body = {
        // The API needs a name; an Arabic-only category sends its Arabic name there too.
        name: form.name.trim() || form.nameAr.trim(),
        // null clears, undefined leaves alone — same convention as the meta
        // fields below. This body is reused by the PUT (edit) branch, so an
        // emptied field MUST send null or the merchant can never clear it.
        nameAr: textFieldValue(form.nameAr.trim(), intent),
        slug: form.slug.trim(),
        description: textFieldValue(form.description.trim(), intent),
        descriptionAr: textFieldValue(form.descriptionAr.trim(), intent),
        image: textFieldValue(form.image, intent),
        metaTitle: form.metaTitle?.trim() || null,
        metaTitleAr: form.metaTitleAr?.trim() || null,
        metaDescription: form.metaDescription?.trim() || null,
        metaDescriptionAr: form.metaDescriptionAr?.trim() || null,
        metaDescriptionAeo: form.metaDescriptionAeo?.trim() || null,
        metaDescriptionAeoAr: form.metaDescriptionAeoAr?.trim() || null,
        showOnHomeStrip: form.showOnHomeStrip ?? true,
        sizeChartId: form.sizeChartId || null,
      };

      const { error: apiError } = isEditing
        ? await apiPut<{ category: Category }>(endpoint, body)
        : await apiPost<{ category: Category }>(endpoint, body);

      if (!apiError) {
        setSaveMessage(isEditing ? tForm('updatedSuccess') : tForm('createdSuccess'));
        await fetchCategories();
        setTimeout(closeForm, 800);
      } else {
        const msg = apiError.message || (isEditing ? tForm('updateFailed') : tForm('createFailed'));
        if (msg.toLowerCase().includes('slug')) {
          setFormErrors(prev => ({ ...prev, slug: tForm('slugInUse') }));
        } else {
          setSaveMessage(msg);
        }
      }
    } catch {
      setSaveMessage(tForm('connectionError'));
    } finally {
      setIsSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;

    setDeletingId(deleteTarget.id);
    try {
      const { error: deleteError } = await apiDelete(
        `/api/v1/stores/${storeId}/categories/${deleteTarget.id}`
      );
      if (!deleteError) {
        toastSuccess(t('toastDeletedTitle'), t('toastDeletedBody', { name: deleteTarget.name }));
        await fetchCategories();
      } else {
        showError(t('errorTitle'), deleteError.message || t('deleteFailed'));
      }
    } catch {
      showError(t('errorTitle'), t('connectionError'));
    } finally {
      setDeletingId(null);
      setDeleteTarget(null);
    }
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <div className="flex items-center gap-2">
          <RowActions
            menuLabel={t('moreMenu')}
            items={[{ label: tTags('manage'), href: `/stores/${storeId}/tags` }]}
          />
          <Button type="button" onClick={openAddForm} variant="default">
            {t('addCategory')}
          </Button>
        </div>
      }
    >
      {/* Search bar */}
      <div className="mb-4">
        <SearchInput
          value={search}
          onSearch={setSearch}
          placeholder={t('searchPlaceholder')}
          className="w-full sm:w-72"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-ink">
          {error}
          <button type="button" className="ms-4 font-medium underline" onClick={fetchCategories}>
            {t('retry')}
          </button>
        </div>
      )}

      {/* A store with no categories: let the assistant propose some from its products. */}
      {!isLoading && !error && categories.length === 0 && (
        <CategorySuggestionPanel storeId={storeId} onCreated={fetchCategories} />
      )}

      {/* Add/Edit Form */}
      {showForm && (
        <div ref={formRef} className="scroll-mt-24">
          <CategoryForm
            editingId={editingId}
            form={form}
            formErrors={formErrors}
            isSaving={isSaving}
            saveMessage={saveMessage}
            onFormChange={setForm}
            onFormErrorChange={setFormErrors}
            onSubmit={handleSubmit}
            onClose={closeForm}
            slugify={slugify}
            arFirst={arFirst}
            storeId={storeId}
            sizeCharts={sizeCharts}
          />
        </div>
      )}

      {/* Best Sellers virtual category cover. The storefront treats
          Best Sellers like any other category tile, so the merchant
          should be able to give it the same visual treatment. The
          image persists on the Store row (not on a Category row),
          which is why this lives outside CategoryTable. */}
      <div className="mb-4 rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              {t('bestSellersCoverTitle')}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('bestSellersCoverHint')}</p>
          </div>
          <div className="md:w-64">
            <ImageUpload
              value={bestSellersImage ?? ''}
              onUpload={url => saveBestSellersImage(url)}
              onRemove={() => saveBestSellersImage(null)}
              folder="categories"
              storeId={storeId}
              label={savingBestSellersImage ? tCommon('saving') : t('uploadCoverLabel')}
              accept="image/jpeg,image/png,image/webp"
              aspectRatio="1/1"
              recommendedSizeHint={recommendedSizeTextForTemplate('categorySquare', storeTemplate)}
            />
          </div>
        </div>

        {/* Show/hide the virtual Best Sellers tile wherever it appears as a
            category card — the homepage category strip AND the /categories page.
            Lives on StoreTheme (showBestSellersTile) — the tile is virtual, so
            it can't use the per-category "Show on homepage strip" toggle. The
            Best Sellers product carousel and its listing page stay regardless. */}
        <div className="mt-4 flex items-center justify-between gap-3 border-t pt-4">
          <div>
            <p className="text-sm font-medium text-foreground">{t('showBestSellersCardTitle')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('showBestSellersCardHint')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={showBestSellersTile}
            aria-label={t('showBestSellersCardTitle')}
            disabled={savingShowBestSellersTile}
            onClick={() => saveShowBestSellersTile(!showBestSellersTile)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
              showBestSellersTile ? 'bg-primary' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                showBestSellersTile ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Category count unit label — merchant-configurable word shown after the count
          on category cards (e.g. "4 pieces" / "4 قطعة"). Saved on StoreTheme JSON. */}
      <div className="mb-4 rounded-xl border bg-card p-4 shadow-sm">
        <div className="mb-3">
          <h3 className="text-base font-semibold text-foreground">{t('countUnitTitle')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('countUnitHint')}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label
              className="mb-1 block text-sm font-medium text-foreground"
              htmlFor="count-unit-en"
            >
              {t('countUnitEnglishLabel')}
            </label>
            <input
              id="count-unit-en"
              type="text"
              value={countUnitEn}
              onChange={e => setCountUnitEn(e.target.value)}
              placeholder={t('countUnitEnSample')}
              maxLength={30}
              className={FIELD_CLASSES}
            />
          </div>
          <div>
            <label
              className="mb-1 block text-sm font-medium text-foreground"
              htmlFor="count-unit-ar"
              dir="rtl"
            >
              {t('countUnitArabicLabel')}
            </label>
            <input
              id="count-unit-ar"
              type="text"
              dir="rtl"
              value={countUnitAr}
              onChange={e => setCountUnitAr(e.target.value)}
              placeholder={t('countUnitArSample')}
              maxLength={30}
              className={FIELD_CLASSES}
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            type="button"
            disabled={savingCountUnit}
            onClick={() => saveCountUnit(countUnitEn, countUnitAr)}
            variant="default"
            size="sm"
            className="gap-2"
          >
            {savingCountUnit ? tCommon('saving') : t('saveLabelButton')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('previewLabel')} <strong>{countUnitEn || t('countUnitEnSample')}</strong> /{' '}
            <strong dir="rtl">{countUnitAr || t('countUnitArSample')}</strong>
          </span>
        </div>
      </div>

      {/* Categories List */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <CategoryTable
          categories={filteredCategories}
          isLoading={isLoading}
          deletingId={deletingId}
          storeId={storeId}
          onEdit={openEditForm}
          onDelete={setDeleteTarget}
          onAddFirst={openAddForm}
          onDragEnd={search.trim() ? undefined : handleDragEnd}
          reordering={reordering}
        />
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-lg font-semibold text-foreground mb-2">{t('deleteTitle')}</h2>
            <p className="text-sm text-muted-foreground mb-6">
              {t('deleteConfirm', { name: deleteTarget.name })}
            </p>
            <div className="flex items-center justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
                {t('cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={confirmDelete}
                disabled={deletingId === deleteTarget.id}
                isLoading={deletingId === deleteTarget.id}
              >
                {deletingId === deleteTarget.id ? t('deleting') : t('delete')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
