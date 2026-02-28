'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button, Modal } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { ImageUpload } from '../../components/ImageUpload';
import { apiGet, apiPost, apiPut, apiDelete } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useStore } from '../../contexts/StoreContext';

interface Category {
  id: string;
  name: string;
  nameAr: string | null;
  slug: string;
  description: string | null;
  descriptionAr: string | null;
  image: string | null;
  productCount: number;
  _count?: { products: number };
}

interface CategoryFormData {
  name: string;
  nameAr: string;
  slug: string;
  description: string;
  descriptionAr: string;
  image: string;
}

const emptyForm: CategoryFormData = {
  name: '',
  nameAr: '',
  slug: '',
  description: '',
  descriptionAr: '',
  image: '',
};

export default function CategoriesPage() {
  const { token } = useAuth();
  const { selectedStoreId, stores: globalStores, isLoading: storesLoading } = useStore();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Categories are per-store — require a specific store selection
  const storeId = selectedStoreId !== 'all' ? selectedStoreId : null;
  const selectedStoreName = globalStores.find(s => s.id === storeId)?.name;

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [formData, setFormData] = useState<CategoryFormData>(emptyForm);
  const [isSaving, setIsSaving] = useState(false);

  // Delete state
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState<Category | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchCategories = useCallback(
    async (sid: string) => {
      if (!token) return;

      try {
        setError(null);
        setLoading(true);

        const { data, error: fetchError } = await apiGet<{
          categories: Category[];
        }>(`/api/v1/stores/${sid}/categories`);

        if (fetchError) {
          setError(fetchError.message || 'Failed to fetch categories');
          return;
        }

        const mapped = (data?.categories || []).map(cat => ({
          ...cat,
          productCount: cat._count?.products ?? cat.productCount ?? 0,
        }));
        setCategories(mapped);
      } catch (err) {
        console.error('Error fetching categories:', err);
        setError('Unable to connect to the server. Please check your connection and try again.');
      } finally {
        setLoading(false);
      }
    },
    [token]
  );

  useEffect(() => {
    if (!token || storesLoading) return;
    if (!storeId) {
      setCategories([]);
      setLoading(false);
      setError(null);
      return;
    }
    fetchCategories(storeId);
  }, [token, storeId, storesLoading, fetchCategories]);

  const refetch = useCallback(() => {
    if (storeId) {
      fetchCategories(storeId);
    }
  }, [storeId, fetchCategories]);

  // Open modal for creating a new category
  const handleAdd = () => {
    setEditingCategory(null);
    setFormData(emptyForm);
    setIsModalOpen(true);
  };

  // Open modal for editing an existing category
  const handleEdit = (category: Category) => {
    setEditingCategory(category);
    setFormData({
      name: category.name,
      nameAr: category.nameAr || '',
      slug: category.slug,
      description: category.description || '',
      descriptionAr: category.descriptionAr || '',
      image: category.image || '',
    });
    setIsModalOpen(true);
  };

  // Submit create or update
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storeId || !formData.name.trim()) return;

    try {
      setIsSaving(true);

      const body: Record<string, string | undefined> = {
        name: formData.name.trim(),
      };
      if (formData.nameAr.trim()) body.nameAr = formData.nameAr.trim();
      if (formData.slug.trim()) body.slug = formData.slug.trim();
      if (formData.description.trim()) body.description = formData.description.trim();
      if (formData.descriptionAr.trim()) body.descriptionAr = formData.descriptionAr.trim();
      if (formData.image) body.image = formData.image;

      if (editingCategory) {
        const { error: updateError } = await apiPut(
          `/api/v1/stores/${storeId}/categories/${editingCategory.id}`,
          body
        );
        if (updateError) {
          console.error('Failed to update category:', updateError.message);
          return;
        }
      } else {
        const { error: createError } = await apiPost(`/api/v1/stores/${storeId}/categories`, body);
        if (createError) {
          console.error('Failed to create category:', createError.message);
          return;
        }
      }

      setIsModalOpen(false);
      setEditingCategory(null);
      setFormData(emptyForm);
      refetch();
    } catch (err) {
      console.error('Error saving category:', err);
    } finally {
      setIsSaving(false);
    }
  };

  // Open delete confirmation
  const handleDelete = (category: Category) => {
    setCategoryToDelete(category);
    setIsDeleteModalOpen(true);
  };

  // Confirm delete
  const confirmDelete = async () => {
    if (!storeId || !categoryToDelete) return;

    try {
      setIsDeleting(true);

      const { error: deleteError } = await apiDelete(
        `/api/v1/stores/${storeId}/categories/${categoryToDelete.id}`
      );
      if (deleteError) {
        console.error('Failed to delete category:', deleteError.message);
        return;
      }

      setIsDeleteModalOpen(false);
      setCategoryToDelete(null);
      refetch();
    } catch (err) {
      console.error('Error deleting category:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AdminLayout
      title="Categories"
      subtitle={
        selectedStoreName
          ? `Manage categories for ${selectedStoreName}`
          : 'Select a store to manage categories'
      }
      actions={
        <Button size="sm" onClick={handleAdd} disabled={!storeId}>
          <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Category
        </Button>
      }
    >
      {!storeId && !storesLoading && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h3 className="mt-4 text-sm font-medium text-gray-900">Select a store</h3>
          <p className="mt-1 text-sm text-gray-500">
            Categories are per-store. Please select a specific store from the sidebar to manage its
            categories.
          </p>
        </div>
      )}

      {error && !loading && storeId && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{error}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={refetch}>
            Retry
          </Button>
        </div>
      )}

      {storeId && loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Category
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Slug
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Products
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {categories.map(category => (
                <tr key={category.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-3">
                      {category.image ? (
                        <img
                          src={category.image}
                          alt={category.name}
                          className="h-10 w-10 rounded-lg object-cover border bg-gray-50"
                        />
                      ) : (
                        <div className="h-10 w-10 rounded-lg bg-gray-100 flex items-center justify-center">
                          <svg
                            className="h-5 w-5 text-gray-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z"
                            />
                          </svg>
                        </div>
                      )}
                      <div>
                        <p className="font-medium text-gray-900">{category.name}</p>
                        {category.nameAr && (
                          <p className="text-xs text-gray-500" dir="rtl">
                            {category.nameAr}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-500 font-mono text-sm">
                    {category.slug}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">{category.productCount}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <button
                      className="text-primary hover:text-primary/80 mr-3"
                      onClick={() => handleEdit(category)}
                    >
                      Edit
                    </button>
                    <button
                      className="text-red-600 hover:text-red-800"
                      onClick={() => handleDelete(category)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {categories.length === 0 && !error && (
            <div className="py-12 text-center">
              <svg
                className="mx-auto h-12 w-12 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z"
                />
              </svg>
              <h3 className="mt-4 text-sm font-medium text-gray-900">No categories found</h3>
              <p className="mt-1 text-sm text-gray-500">
                Get started by adding your first category.
              </p>
              <Button className="mt-4" onClick={handleAdd}>
                Add Category
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Create / Edit Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingCategory ? 'Edit Category' : 'Add Category'}
      >
        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            {/* Icon Upload */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category Icon</label>
              <ImageUpload
                value={formData.image || undefined}
                onUpload={url => setFormData(prev => ({ ...prev, image: url }))}
                onRemove={() => setFormData(prev => ({ ...prev, image: '' }))}
                folder="categories"
                label="Upload icon"
              />
            </div>
            <div>
              <label
                htmlFor="category-name"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Name <span className="text-red-500">*</span>
              </label>
              <input
                id="category-name"
                type="text"
                required
                value={formData.name}
                onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="e.g. Electronics"
              />
            </div>
            <div>
              <label
                htmlFor="category-name-ar"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Name (Arabic)
              </label>
              <input
                id="category-name-ar"
                type="text"
                value={formData.nameAr}
                onChange={e => setFormData(prev => ({ ...prev, nameAr: e.target.value }))}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="مثال: إلكترونيات"
                dir="rtl"
              />
            </div>
            <div>
              <label
                htmlFor="category-slug"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Slug
              </label>
              <input
                id="category-slug"
                type="text"
                value={formData.slug}
                onChange={e => setFormData(prev => ({ ...prev, slug: e.target.value }))}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="e.g. electronics (auto-generated if empty)"
              />
            </div>
            <div>
              <label
                htmlFor="category-description"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Description
              </label>
              <textarea
                id="category-description"
                rows={3}
                value={formData.description}
                onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="Optional description for this category"
              />
            </div>
            <div>
              <label
                htmlFor="category-description-ar"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Description (Arabic)
              </label>
              <textarea
                id="category-description-ar"
                rows={3}
                value={formData.descriptionAr}
                onChange={e => setFormData(prev => ({ ...prev, descriptionAr: e.target.value }))}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="وصف اختياري لهذا التصنيف"
                dir="rtl"
              />
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              onClick={() => setIsModalOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" className="rounded-xl" disabled={isSaving}>
              {isSaving
                ? editingCategory
                  ? 'Saving...'
                  : 'Creating...'
                : editingCategory
                  ? 'Save Changes'
                  : 'Create Category'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        title="Delete Category"
      >
        <p className="text-sm text-muted-foreground">
          Are you sure you want to delete <strong>{categoryToDelete?.name}</strong>? This action
          cannot be undone.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            className="rounded-xl"
            onClick={() => setIsDeleteModalOpen(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="rounded-xl"
            onClick={confirmDelete}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </Modal>
    </AdminLayout>
  );
}
