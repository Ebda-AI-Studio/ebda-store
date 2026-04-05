'use client';

import { ImageUpload } from '../../../../components/ImageUpload';

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
}: CategoryFormProps) {
  return (
    <div className="mb-6 rounded-xl border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b p-4">
        <h2 className="font-semibold text-foreground">
          {editingId ? 'Edit Category' : 'Add Category'}
        </h2>
        <button
          onClick={onClose}
          className="p-1 text-muted-foreground hover:text-muted-foreground"
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
      <form onSubmit={onSubmit} className="p-6 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Name (English) <span className="text-red-500">*</span>
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
              placeholder="Electronics"
              className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${formErrors.name ? 'border-red-500' : 'border-border'}`}
            />
            {formErrors.name && <p className="mt-1 text-xs text-red-500">{formErrors.name}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Name (Arabic)</label>
            <input
              type="text"
              dir="rtl"
              value={form.nameAr}
              onChange={e => onFormChange(prev => ({ ...prev, nameAr: e.target.value }))}
              placeholder="إلكترونيات"
              className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            URL Slug <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={form.slug}
            onChange={e => {
              onFormChange(prev => ({ ...prev, slug: slugify(e.target.value) }));
              if (formErrors.slug) onFormErrorChange(prev => ({ ...prev, slug: '' }));
            }}
            placeholder="electronics"
            className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${formErrors.slug ? 'border-red-500' : 'border-border'}`}
          />
          {formErrors.slug && <p className="mt-1 text-xs text-red-500">{formErrors.slug}</p>}
          <p className="mt-1 text-xs text-muted-foreground">
            Used in URLs: lowercase, hyphens only
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={e => onFormChange(prev => ({ ...prev, description: e.target.value }))}
              placeholder="Category description..."
              rows={3}
              className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Description (Arabic)
            </label>
            <textarea
              dir="rtl"
              value={form.descriptionAr}
              onChange={e => onFormChange(prev => ({ ...prev, descriptionAr: e.target.value }))}
              placeholder="وصف التصنيف..."
              rows={3}
              className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Category Image</label>
          <ImageUpload
            value={form.image || undefined}
            onUpload={url => onFormChange(prev => ({ ...prev, image: url }))}
            onRemove={() => onFormChange(prev => ({ ...prev, image: '' }))}
            folder="categories"
            label="Upload Category Image"
          />
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

        <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-foreground border border-border rounded-lg hover:bg-muted"
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
  );
}
