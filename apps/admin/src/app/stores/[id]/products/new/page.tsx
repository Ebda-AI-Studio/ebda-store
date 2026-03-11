'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Input, Textarea, Select } from '@force/ui';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { MultiImageUpload } from '../../../../../components/ImageUpload';
import { useAuth } from '../../../../../lib/auth';
import { apiGet, apiPost } from '../../../../../lib/api';

interface Category {
  id: string;
  name: string;
}

const statuses = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
];

export default function NewProductPage() {
  const router = useRouter();
  const params = useParams();
  const storeId = params?.id as string;
  const { isAuthenticated } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [images, setImages] = useState<string[]>([]);

  const [formData, setFormData] = useState({
    name: '',
    nameAr: '',
    description: '',
    descriptionAr: '',
    price: '',
    compareAtPrice: '',
    sku: '',
    inventory: '',
    category: '',
    status: 'draft',
  });

  // Fetch categories for this store
  useEffect(() => {
    if (!storeId || !isAuthenticated) return;

    async function fetchCategories() {
      try {
        const { data } = await apiGet<{ categories: Category[] }>(
          `/api/v1/stores/${storeId}/categories`
        );
        if (data?.categories) {
          setCategories(data.categories);
        }
      } catch {
        setCategories([]);
      }
    }

    fetchCategories();
  }, [storeId, isAuthenticated]);

  const updateField = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const priceInFils = Math.round(parseFloat(formData.price) * 1000);
      const compareAtPriceInFils = formData.compareAtPrice
        ? Math.round(parseFloat(formData.compareAtPrice) * 1000)
        : undefined;

      const body: Record<string, unknown> = {
        name: formData.name,
        nameAr: formData.nameAr || undefined,
        description: formData.description || undefined,
        descriptionAr: formData.descriptionAr || undefined,
        price: priceInFils,
        compareAtPrice: compareAtPriceInFils,
        sku: formData.sku || undefined,
        inventory: formData.inventory ? parseInt(formData.inventory, 10) : 0,
        status: formData.status,
        images: images.map(url => ({ url })),
      };

      if (formData.category) {
        body.categories = [formData.category];
      }

      const { data, error: apiError } = await apiPost(`/api/v1/stores/${storeId}/products`, body);

      if (apiError) {
        setError(apiError.message);
        return;
      }

      if (data) {
        router.push(`/stores/${storeId}/products`);
      }
    } catch {
      setError('Failed to create product. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const categoryOptions = [
    { value: '', label: 'No category' },
    ...categories.map(c => ({ value: c.id, label: c.name })),
  ];

  return (
    <AdminLayout title="Add New Product" subtitle="Create a new product for your store">
      <form onSubmit={handleSubmit}>
        {error && <div className="mb-6 rounded-lg bg-red-50 p-4 text-sm text-red-600">{error}</div>}

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">Basic Information</h2>
              <div className="space-y-4">
                <Input
                  label="Product Name"
                  value={formData.name}
                  onChange={e => updateField('name', e.target.value)}
                  placeholder="Enter product name"
                  required
                />
                <Input
                  label="Product Name (Arabic)"
                  value={formData.nameAr}
                  onChange={e => updateField('nameAr', e.target.value)}
                  placeholder="ادخل اسم المنتج"
                  dir="rtl"
                />
                <Textarea
                  label="Description"
                  value={formData.description}
                  onChange={e => updateField('description', e.target.value)}
                  placeholder="Describe your product..."
                  rows={4}
                />
                <Textarea
                  label="Description (Arabic)"
                  value={formData.descriptionAr}
                  onChange={e => updateField('descriptionAr', e.target.value)}
                  placeholder="وصف المنتج..."
                  rows={4}
                  dir="rtl"
                />
              </div>
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">Media</h2>
              <MultiImageUpload
                values={images}
                onChange={setImages}
                folder="products"
                label="Drag and drop images here, or click to select"
                max={10}
              />
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">Pricing</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Price (KWD)"
                  type="number"
                  step="0.001"
                  value={formData.price}
                  onChange={e => updateField('price', e.target.value)}
                  placeholder="0.000"
                  required
                />
                <Input
                  label="Compare at Price (KWD)"
                  type="number"
                  step="0.001"
                  value={formData.compareAtPrice}
                  onChange={e => updateField('compareAtPrice', e.target.value)}
                  placeholder="0.000"
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Enter prices in KWD. Compare at price is used to show a crossed-out price.
              </p>
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">Inventory</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="SKU"
                  value={formData.sku}
                  onChange={e => updateField('sku', e.target.value)}
                  placeholder="PROD-001"
                />
                <Input
                  label="Quantity"
                  type="number"
                  value={formData.inventory}
                  onChange={e => updateField('inventory', e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">Status</h2>
              <Select
                label="Product Status"
                value={formData.status}
                onChange={e => updateField('status', e.target.value)}
                options={statuses}
              />
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">Organization</h2>
              <Select
                label="Category"
                value={formData.category}
                onChange={e => updateField('category', e.target.value)}
                options={categoryOptions}
              />
            </div>

            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <div className="space-y-3">
                <Button type="submit" className="w-full" isLoading={isLoading}>
                  Create Product
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => router.push(`/stores/${storeId}/products`)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      </form>
    </AdminLayout>
  );
}
