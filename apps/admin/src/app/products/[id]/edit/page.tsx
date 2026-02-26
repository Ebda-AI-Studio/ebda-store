'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Button, Input, Textarea, Select } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { MultiImageUpload } from '../../../../components/ImageUpload';
import { useAuth } from '../../../../lib/auth';
import { apiPut, getApiUrl } from '../../../../lib/api';

interface Product {
  id: string;
  storeId: string;
  name: string;
  nameAr?: string;
  slug: string;
  description?: string;
  descriptionAr?: string;
  price: number;
  compareAtPrice?: number;
  costPrice?: number;
  sku?: string;
  barcode?: string;
  inventory: number;
  lowStockThreshold: number;
  trackInventory: boolean;
  status: string;
  isFeatured: boolean;
  isNew: boolean;
  weight?: number;
  categories: { id: string; name: string }[];
  images: { id: string; url: string; alt?: string; position: number }[];
  tags: string[];
  store: { id: string; name: string; slug: string };
}

interface Category {
  id: string;
  name: string;
}

const statuses = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
];

export default function EditProductPage() {
  const params = useParams();
  const router = useRouter();
  const { token } = useAuth();

  const productId = params.id as string;

  const [product, setProduct] = useState<Product | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    nameAr: '',
    description: '',
    descriptionAr: '',
    price: '',
    compareAtPrice: '',
    sku: '',
    inventory: '',
    status: 'draft',
    isFeatured: false,
    isNew: false,
    category: '',
  });

  // Fetch product data
  useEffect(() => {
    async function fetchProduct() {
      if (!token) return;

      try {
        setLoading(true);
        const response = await fetch(`${getApiUrl()}/api/v1/admin/products/${productId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          if (response.status === 404) {
            setError('Product not found');
          } else {
            setError('Failed to load product');
          }
          return;
        }

        const data = await response.json();
        const p = data.data.product as Product;
        setProduct(p);

        // Pre-fill images sorted by position
        if (p.images?.length) {
          setImages([...p.images].sort((a, b) => a.position - b.position).map(img => img.url));
        }

        // Pre-fill form with product data; convert price from fils to KWD
        setFormData({
          name: p.name || '',
          nameAr: p.nameAr || '',
          description: p.description || '',
          descriptionAr: p.descriptionAr || '',
          price: p.price ? (p.price / 1000).toFixed(3) : '',
          compareAtPrice: p.compareAtPrice ? (p.compareAtPrice / 1000).toFixed(3) : '',
          sku: p.sku || '',
          inventory: String(p.inventory ?? 0),
          status: p.status || 'draft',
          isFeatured: p.isFeatured || false,
          isNew: p.isNew || false,
          category: p.categories?.[0]?.id || '',
        });
      } catch (err) {
        console.error('Error fetching product:', err);
        setError('Failed to load product');
      } finally {
        setLoading(false);
      }
    }

    fetchProduct();
  }, [productId, token]);

  // Fetch categories when product is loaded (need storeId)
  useEffect(() => {
    if (!product?.storeId || !token) return;

    async function fetchCategories() {
      try {
        const response = await fetch(
          `${getApiUrl()}/api/v1/stores/${product!.storeId}/categories`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
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
  }, [product?.storeId, token]);

  const updateField = (field: string, value: string | boolean) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product) return;

    setError(null);
    setSaving(true);

    try {
      // Convert price from KWD to fils (1 KWD = 1000 fils)
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
        isFeatured: formData.isFeatured,
        isNew: formData.isNew,
        images: images.map((url, i) => ({ url, position: i })),
      };

      if (formData.category) {
        body.categories = [formData.category];
      } else {
        body.categories = [];
      }

      const { error: apiError } = await apiPut(
        `/api/v1/stores/${product.storeId}/products/${product.id}`,
        body
      );

      if (apiError) {
        setError(apiError.message);
        return;
      }

      router.push(`/products/${productId}`);
    } catch {
      setError('Failed to update product. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const categoryOptions = [
    { value: '', label: 'No category' },
    ...categories.map(c => ({ value: c.id, label: c.name })),
  ];

  if (loading) {
    return (
      <AdminLayout title="Loading..." subtitle="">
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      </AdminLayout>
    );
  }

  if (error && !product) {
    return (
      <AdminLayout title="Product Not Found" subtitle="">
        <div className="rounded-xl border bg-white p-8 text-center">
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
              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
            />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-gray-900">{error}</h3>
          <p className="mt-2 text-sm text-gray-500">
            The product you&apos;re looking for doesn&apos;t exist or has been removed.
          </p>
          <Link href="/products">
            <Button className="mt-6">Back to Products</Button>
          </Link>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={`Edit: ${product?.name || 'Product'}`}
      subtitle={`Store: ${product?.store?.name || 'Unknown'}`}
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

            {/* Flags */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Product Flags</h2>
              <div className="space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.isFeatured}
                    onChange={e => updateField('isFeatured', e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <span className="text-sm text-gray-700">Featured Product</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.isNew}
                    onChange={e => updateField('isNew', e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <span className="text-sm text-gray-700">New Arrival</span>
                </label>
              </div>
            </div>

            {/* Actions */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <div className="space-y-3">
                <Button type="submit" className="w-full" isLoading={saving}>
                  Save Changes
                </Button>
                <Link href={`/products/${productId}`} className="block">
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
