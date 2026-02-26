'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Input, Textarea, Select } from '@force/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { MultiImageUpload } from '../../../components/ImageUpload';
import { useAuth } from '../../../lib/auth';
import { apiGet, apiPost, getApiUrl } from '../../../lib/api';

interface Store {
  id: string;
  name: string;
}

interface Category {
  id: string;
  name: string;
}

const statuses = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
];

export default function NewProductPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { token } = useAuth();
  const storeIdParam = searchParams.get('storeId');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [stores, setStores] = useState<Store[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');

  const [images, setImages] = useState<string[]>([]);

  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    description: '',
    price: '',
    compareAtPrice: '',
    sku: '',
    inventory: '',
    category: '',
    status: 'draft',
  });

  // Fetch stores on mount
  useEffect(() => {
    async function fetchStores() {
      const { data } = await apiGet<{ stores: Store[] }>('/api/v1/admin/stores');
      if (data?.stores) {
        setStores(data.stores);
        if (storeIdParam && data.stores.some(s => s.id === storeIdParam)) {
          setSelectedStoreId(storeIdParam);
        } else if (data.stores.length === 1) {
          setSelectedStoreId(data.stores[0].id);
        }
      }
    }
    if (token) fetchStores();
  }, [token]);

  // Fetch categories when store changes
  useEffect(() => {
    if (!selectedStoreId) {
      setCategories([]);
      return;
    }

    async function fetchCategories() {
      try {
        const response = await fetch(`${getApiUrl()}/api/v1/stores/${selectedStoreId}/categories`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const result = await response.json();
        if (result.success && result.data?.categories) {
          setCategories(result.data.categories);
        }
      } catch {
        // Categories may not exist yet for this store
        setCategories([]);
      }
    }

    fetchCategories();
  }, [selectedStoreId, token]);

  const updateField = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (field === 'name') {
      const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      setFormData(prev => ({ ...prev, slug }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedStoreId) {
      setError('Please select a store.');
      return;
    }

    setIsLoading(true);

    try {
      // Convert price from KWD to fils (1 KWD = 1000 fils)
      const priceInFils = Math.round(parseFloat(formData.price) * 1000);
      const compareAtPriceInFils = formData.compareAtPrice
        ? Math.round(parseFloat(formData.compareAtPrice) * 1000)
        : undefined;

      const body: Record<string, unknown> = {
        name: formData.name,
        slug: formData.slug,
        description: formData.description || undefined,
        price: priceInFils,
        compareAtPrice: compareAtPriceInFils,
        sku: formData.sku || undefined,
        inventory: formData.inventory ? parseInt(formData.inventory, 10) : 0,
        status: formData.status,
        images: images.map((url, i) => ({ url, position: i })),
      };

      if (formData.category) {
        body.categories = [formData.category];
      }

      const { data, error: apiError } = await apiPost(
        `/api/v1/stores/${selectedStoreId}/products`,
        body
      );

      if (apiError) {
        setError(apiError.message);
        return;
      }

      if (data) {
        router.push(storeIdParam ? `/stores/${storeIdParam}/products` : '/products');
      }
    } catch {
      setError('Failed to create product. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const storeOptions = stores.map(s => ({ value: s.id, label: s.name }));
  const categoryOptions = [
    { value: '', label: 'No category' },
    ...categories.map(c => ({ value: c.id, label: c.name })),
  ];

  return (
    <AdminLayout
      title="Add New Product"
      subtitle="Create a new product for your store"
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            router.push(storeIdParam ? `/stores/${storeIdParam}/products` : '/products')
          }
        >
          <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          Back
        </Button>
      }
    >
      <form onSubmit={handleSubmit}>
        {error && <div className="mb-6 rounded-lg bg-red-50 p-4 text-sm text-red-600">{error}</div>}

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Basic Information */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h2>
              <div className="space-y-4">
                <Input
                  label="Product Name"
                  value={formData.name}
                  onChange={e => updateField('name', e.target.value)}
                  placeholder="Enter product name"
                  required
                />
                <Input
                  label="Slug"
                  value={formData.slug}
                  onChange={e => updateField('slug', e.target.value)}
                  placeholder="product-url-slug"
                  required
                />
                <Textarea
                  label="Description"
                  value={formData.description}
                  onChange={e => updateField('description', e.target.value)}
                  placeholder="Describe your product..."
                  rows={5}
                />
              </div>
            </div>

            {/* Media */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Media</h2>
              <MultiImageUpload
                values={images}
                onChange={setImages}
                folder="products"
                label="Drag and drop images here, or click to select"
                max={10}
              />
            </div>

            {/* Pricing */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Pricing</h2>
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
              <p className="mt-2 text-xs text-gray-500">
                Enter prices in KWD. Compare at price is used to show a crossed-out price.
              </p>
            </div>

            {/* Inventory */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Inventory</h2>
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
            {/* Store Selection */}
            {stores.length > 1 && !storeIdParam && (
              <div className="rounded-xl border bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Store</h2>
                <Select
                  label="Select Store"
                  value={selectedStoreId}
                  onChange={e => setSelectedStoreId(e.target.value)}
                  options={[{ value: '', label: 'Choose a store...' }, ...storeOptions]}
                />
              </div>
            )}

            {/* Status */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Status</h2>
              <Select
                label="Product Status"
                value={formData.status}
                onChange={e => updateField('status', e.target.value)}
                options={statuses}
              />
            </div>

            {/* Organization */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Organization</h2>
              <Select
                label="Category"
                value={formData.category}
                onChange={e => updateField('category', e.target.value)}
                options={categoryOptions}
              />
            </div>

            {/* Actions */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <div className="space-y-3">
                <Button type="submit" className="w-full" isLoading={isLoading}>
                  Create Product
                </Button>
                <Link
                  href={storeIdParam ? `/stores/${storeIdParam}/products` : '/products'}
                  className="block"
                >
                  <Button type="button" variant="outline" className="w-full">
                    Cancel
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </form>
    </AdminLayout>
  );
}
