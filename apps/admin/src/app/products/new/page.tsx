'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Input, Textarea, Select } from '@force/ui';
import { AdminLayout } from '../../../components/AdminLayout';

const categories = [
  { value: 'electronics', label: 'Electronics' },
  { value: 'wearables', label: 'Wearables' },
  { value: 'accessories', label: 'Accessories' },
  { value: 'clothing', label: 'Clothing' },
  { value: 'home', label: 'Home & Living' },
];

const statuses = [
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
];

export default function NewProductPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    description: '',
    price: '',
    compareAtPrice: '',
    sku: '',
    inventory: '',
    category: 'electronics',
    status: 'draft',
  });

  const updateField = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    // Auto-generate slug from name
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
    setIsLoading(true);

    try {
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 1000));
      alert('Product created successfully!');
      window.location.href = '/products';
    } catch (error) {
      console.error('Failed to create product:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AdminLayout title="Add New Product" subtitle="Create a new product for your store">
      <form onSubmit={handleSubmit}>
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
              <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center">
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
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
                <p className="mt-2 text-sm text-gray-600">
                  Drag and drop images here, or click to select
                </p>
                <Button type="button" variant="outline" size="sm" className="mt-4">
                  Upload Images
                </Button>
              </div>
            </div>

            {/* Pricing */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Pricing</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Price"
                  type="number"
                  step="0.01"
                  value={formData.price}
                  onChange={e => updateField('price', e.target.value)}
                  placeholder="0.00"
                  required
                />
                <Input
                  label="Compare at Price"
                  type="number"
                  step="0.01"
                  value={formData.compareAtPrice}
                  onChange={e => updateField('compareAtPrice', e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Enter prices in dollars. Compare at price is used to show a crossed-out price.
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
                options={categories}
              />
            </div>

            {/* Actions */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <div className="space-y-3">
                <Button type="submit" className="w-full" isLoading={isLoading}>
                  Create Product
                </Button>
                <Link href="/products" className="block">
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
