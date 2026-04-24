'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
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

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

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
            <button
              type="button"
              className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted font-medium"
            >
              {t('backToStore')}
            </button>
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
        />
      )}

      {/* Categories List */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <CategoryTable
          categories={categories}
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
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 text-sm text-foreground border border-border rounded-lg hover:bg-muted"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deletingId === deleteTarget.id}
                className="px-4 py-2 text-sm bg-destructive text-white rounded-lg hover:bg-destructive/90 disabled:opacity-50"
              >
                {deletingId === deleteTarget.id ? t('deleting') : t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
