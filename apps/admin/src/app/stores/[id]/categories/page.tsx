'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button, useToast } from '@force/ui';
import { recommendedSizeTextForTemplate, type TemplateId } from '@force/shared';
import { AdminLayout } from '../../../../components/AdminLayout';
import { ImageUpload } from '../../../../components/ImageUpload';
import { SearchInput } from '../../../../components/SearchInput';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../lib/api';
import { CategoryForm, type CategoryFormData } from './CategoryForm';
import { CategoryTable, type Category } from './CategoryTable';
import { useT } from '@/i18n/useT';

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
};

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u0600-\u06FF-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function StoreCategoriesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('categories.page');
  const tForm = useT('categories.form');

  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Debounced search term — client-side filter over category name (EN + AR).
  const [search, setSearch] = useState('');

  // Form state for add/edit
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CategoryFormData>(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Delete state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const { success: toastSuccess, error: showError } = useToast();

  /** Template of the store — used to show per-theme recommended upload sizes. */
  const [storeTemplate, setStoreTemplate] = useState<TemplateId | undefined>();

  // Best Sellers virtual category cover. Lives on the Store row, not on
  // a Category row — so it gets its own tiny GET/PUT pair instead of
  // riding the categories CRUD.
  const [bestSellersImage, setBestSellersImage] = useState<string | null>(null);
  const [savingBestSellersImage, setSavingBestSellersImage] = useState(false);

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
        toastSuccess(image ? 'Best Sellers cover updated' : 'Best Sellers cover removed');
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

  useEffect(() => {
    fetchCategories();
    fetchBestSellersImage();
    // Fetch store template for per-theme upload-size hint (non-critical).
    if (storeId) {
      apiGet<{ store: { template?: TemplateId } }>(`/api/v1/admin/stores/${storeId}`)
        .then(({ data }) => {
          if (data?.store?.template) setStoreTemplate(data.store.template);
        })
        .catch(() => {
          // non-critical — falls back to base recommended size
        });
    }
  }, [fetchCategories, fetchBestSellersImage, storeId]);

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
    if (!form.name.trim()) errors.name = tForm('errorNameRequired');
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
      const endpoint = isEditing
        ? `/api/v1/stores/${storeId}/categories/${editingId}`
        : `/api/v1/stores/${storeId}/categories`;

      const body = {
        name: form.name.trim(),
        nameAr: form.nameAr.trim() || undefined,
        slug: form.slug.trim(),
        description: form.description.trim() || undefined,
        descriptionAr: form.descriptionAr.trim() || undefined,
        image: form.image || undefined,
        metaTitle: form.metaTitle?.trim() || null,
        metaTitleAr: form.metaTitleAr?.trim() || null,
        metaDescription: form.metaDescription?.trim() || null,
        metaDescriptionAr: form.metaDescriptionAr?.trim() || null,
        metaDescriptionAeo: form.metaDescriptionAeo?.trim() || null,
        metaDescriptionAeoAr: form.metaDescriptionAeoAr?.trim() || null,
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
        <div className="flex gap-2">
          <Link href={`/stores/${storeId}`}>
            <Button type="button" variant="outline">
              {t('backToStore')}
            </Button>
          </Link>
          <button
            type="button"
            onClick={openAddForm}
            className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 font-medium"
          >
            {t('addCategory')}
          </button>
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
        <div className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
          <button type="button" className="ms-4 font-medium underline" onClick={fetchCategories}>
            {t('retry')}
          </button>
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && (
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
          storeId={storeId}
        />
      )}

      {/* Best Sellers virtual category cover. The storefront treats
          Best Sellers like any other category tile, so the merchant
          should be able to give it the same visual treatment. The
          image persists on the Store row (not on a Category row),
          which is why this lives outside CategoryTable. */}
      <div className="mb-4 rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-base font-semibold text-foreground">Best Sellers cover</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Shown on the storefront's Best Sellers tile alongside your real categories. The tile
              only renders when at least one product is flagged as a best seller.
            </p>
          </div>
          <div className="md:w-64">
            <ImageUpload
              value={bestSellersImage ?? ''}
              onUpload={url => saveBestSellersImage(url)}
              onRemove={() => saveBestSellersImage(null)}
              folder="categories"
              storeId={storeId}
              label={savingBestSellersImage ? 'Saving…' : 'Upload cover'}
              accept="image/jpeg,image/png,image/webp"
              aspectRatio="1/1"
              recommendedSizeHint={recommendedSizeTextForTemplate('categorySquare', storeTemplate)}
            />
          </div>
        </div>
      </div>

      {/* Categories List */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <CategoryTable
          categories={filteredCategories}
          isLoading={isLoading}
          deletingId={deletingId}
          onEdit={openEditForm}
          onDelete={setDeleteTarget}
          onAddFirst={openAddForm}
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
