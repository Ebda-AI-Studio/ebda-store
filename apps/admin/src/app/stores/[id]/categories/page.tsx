'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { getApiUrl } from '../../../../lib/api';

interface Category {
  id: string;
  name: string;
  nameAr: string | null;
  slug: string;
  description: string | null;
  descriptionAr: string | null;
  isActive: boolean;
  sortOrder: number;
  _count?: { products: number };
}

const API_URL = getApiUrl();

const emptyForm = {
  name: '',
  nameAr: '',
  slug: '',
  description: '',
  descriptionAr: '',
};

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function StoreCategoriesPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state for add/edit
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Delete state
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchCategories = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(`${API_URL}/api/v1/stores/${storeId}/products/categories`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setCategories(data.data?.categories || data.data || []);
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(errData.error?.message || 'Failed to fetch categories');
      }
    } catch {
      setError('Unable to connect to the server. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

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
    if (!form.name.trim()) errors.name = 'Name is required';
    if (!form.slug.trim()) {
      errors.slug = 'Slug is required';
    } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.slug)) {
      errors.slug = 'Slug must be lowercase letters, numbers and hyphens only';
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
      const token = localStorage.getItem('authToken');
      const isEditing = !!editingId;
      const url = isEditing
        ? `${API_URL}/api/v1/stores/${storeId}/products/categories/${editingId}`
        : `${API_URL}/api/v1/stores/${storeId}/products/categories`;

      const res = await fetch(url, {
        method: isEditing ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: form.name.trim(),
          nameAr: form.nameAr.trim() || undefined,
          slug: form.slug.trim(),
          description: form.description.trim() || undefined,
          descriptionAr: form.descriptionAr.trim() || undefined,
        }),
      });

      if (res.ok) {
        setSaveMessage(
          isEditing ? 'Category updated successfully' : 'Category created successfully'
        );
        await fetchCategories();
        setTimeout(closeForm, 800);
      } else {
        const errData = await res.json().catch(() => ({}));
        const msg =
          errData.error?.message ||
          (isEditing ? 'Failed to update category' : 'Failed to create category');
        if (msg.toLowerCase().includes('slug')) {
          setFormErrors(prev => ({ ...prev, slug: 'This slug is already in use' }));
        } else {
          setSaveMessage(msg);
        }
      }
    } catch {
      setSaveMessage('Unable to connect to the server');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(catId: string, catName: string) {
    if (!window.confirm(`Delete category "${catName}"? This cannot be undone.`)) return;

    setDeletingId(catId);
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(`${API_URL}/api/v1/stores/${storeId}/products/categories/${catId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        await fetchCategories();
      } else {
        const errData = await res.json().catch(() => ({}));
        alert(errData.error?.message || 'Failed to delete category');
      }
    } catch {
      alert('Unable to connect to the server');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <AdminLayout
      title="Product Categories"
      subtitle="Manage categories for this store"
      actions={
        <div className="flex gap-2">
          <Link href={`/stores/${storeId}`}>
            <button className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 font-medium">
              Back to Store
            </button>
          </Link>
          <button
            onClick={openAddForm}
            className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 font-medium"
          >
            Add Category
          </button>
        </div>
      }
    >
      {/* Error */}
      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button className="ml-4 font-medium underline" onClick={fetchCategories}>
            Retry
          </button>
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && (
        <div className="mb-6 rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="font-semibold text-gray-900">
              {editingId ? 'Edit Category' : 'Add Category'}
            </h2>
            <button
              onClick={closeForm}
              className="p-1 text-gray-400 hover:text-gray-600"
              aria-label="Close"
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
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name (English) <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => {
                    const val = e.target.value;
                    setForm(prev => ({
                      ...prev,
                      name: val,
                      // Auto-generate slug only when adding, not editing
                      slug: !editingId ? slugify(val) : prev.slug,
                    }));
                    if (formErrors.name) setFormErrors(prev => ({ ...prev, name: '' }));
                  }}
                  placeholder="Electronics"
                  className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${formErrors.name ? 'border-red-500' : 'border-gray-300'}`}
                />
                {formErrors.name && <p className="mt-1 text-xs text-red-500">{formErrors.name}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name (Arabic)
                </label>
                <input
                  type="text"
                  dir="rtl"
                  value={form.nameAr}
                  onChange={e => setForm(prev => ({ ...prev, nameAr: e.target.value }))}
                  placeholder="إلكترونيات"
                  className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                URL Slug <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.slug}
                onChange={e => {
                  setForm(prev => ({ ...prev, slug: slugify(e.target.value) }));
                  if (formErrors.slug) setFormErrors(prev => ({ ...prev, slug: '' }));
                }}
                placeholder="electronics"
                className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${formErrors.slug ? 'border-red-500' : 'border-gray-300'}`}
              />
              {formErrors.slug && <p className="mt-1 text-xs text-red-500">{formErrors.slug}</p>}
              <p className="mt-1 text-xs text-gray-500">Used in URLs: lowercase, hyphens only</p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Category description..."
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description (Arabic)
                </label>
                <textarea
                  dir="rtl"
                  value={form.descriptionAr}
                  onChange={e => setForm(prev => ({ ...prev, descriptionAr: e.target.value }))}
                  placeholder="وصف التصنيف..."
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
              </div>
            </div>

            {saveMessage && (
              <p
                className={`text-sm ${
                  saveMessage.includes('success') ? 'text-emerald-600' : 'text-red-600'
                }`}
              >
                {saveMessage}
              </p>
            )}

            <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
              <button
                type="button"
                onClick={closeForm}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="px-6 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
              >
                {isSaving ? 'Saving...' : editingId ? 'Update Category' : 'Create Category'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Categories List */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="space-y-4 p-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 animate-pulse">
                <div className="h-10 w-10 rounded-xl bg-gray-200" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 rounded bg-gray-200" />
                  <div className="h-3 w-20 rounded bg-gray-200" />
                </div>
                <div className="h-8 w-20 rounded bg-gray-200" />
              </div>
            ))}
          </div>
        ) : categories.length === 0 ? (
          <div className="py-16 text-center">
            <svg
              className="mx-auto h-12 w-12 text-gray-300"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
              />
            </svg>
            <p className="mt-4 text-gray-500">No categories yet</p>
            <button onClick={openAddForm} className="mt-4 text-sm text-primary hover:underline">
              Add your first category
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Category
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Slug
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Products
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hidden md:table-cell">
                    Status
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {categories.map(cat => (
                  <tr key={cat.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4">
                      <div>
                        <p className="font-medium text-gray-900">{cat.name}</p>
                        {cat.nameAr && <p className="text-sm text-gray-500">{cat.nameAr}</p>}
                        {cat.description && (
                          <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">
                            {cat.description}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-mono text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded">
                        {cat.slug}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm font-medium text-gray-900">
                        {cat._count?.products ?? 0}
                      </span>
                    </td>
                    <td className="px-6 py-4 hidden md:table-cell">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                          cat.isActive
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${cat.isActive ? 'bg-emerald-500' : 'bg-gray-400'}`}
                        />
                        {cat.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => openEditForm(cat)}
                          className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(cat.id, cat.name)}
                          disabled={deletingId === cat.id}
                          className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
                        >
                          {deletingId === cat.id ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
