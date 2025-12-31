'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Badge, Input, Label } from '@force/ui';
import { AdminLayout } from '../../../../../../components/AdminLayout';

interface OptionValue {
  id: string;
  value: string;
  valueAr: string | null;
  position: number;
}

interface Option {
  id: string;
  name: string;
  nameAr: string | null;
  position: number;
  values: OptionValue[];
}

interface Variant {
  id: string;
  title: string;
  titleAr: string | null;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  compareAtPrice: number | null;
  costPrice: number | null;
  inventory: number;
  weight: number | null;
  imageUrl: string | null;
  isActive: boolean;
  optionValues: Array<{
    optionId: string;
    optionName: string;
    optionNameAr: string | null;
    valueId: string;
    value: string;
    valueAr: string | null;
  }>;
}

interface ProductInfo {
  id: string;
  name: string;
  nameAr: string | null;
  price: number;
  hasVariants: boolean;
  inventory: number;
}

function formatPrice(fils: number) {
  return `${(fils / 1000).toFixed(3)} KWD`;
}

export default function ProductVariantsPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const productId = params?.productId as string;

  const [product, setProduct] = useState<ProductInfo | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Modal states
  const [showAddOption, setShowAddOption] = useState(false);
  const [showAddValue, setShowAddValue] = useState<string | null>(null);
  const [editingVariant, setEditingVariant] = useState<Variant | null>(null);

  // Form states
  const [newOptionName, setNewOptionName] = useState('');
  const [newOptionNameAr, setNewOptionNameAr] = useState('');
  const [newOptionValues, setNewOptionValues] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newValueAr, setNewValueAr] = useState('');

  const [variantForm, setVariantForm] = useState({
    sku: '',
    barcode: '',
    price: '',
    compareAtPrice: '',
    costPrice: '',
    inventory: '',
    weight: '',
  });

  const fetchVariants = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/products/${productId}/variants`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.ok) {
        const data = await response.json();
        setProduct(data.data.product);
        setOptions(data.data.options);
        setVariants(data.data.variants);
      }
    } catch (error) {
      console.error('Failed to fetch variants:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, productId]);

  useEffect(() => {
    fetchVariants();
  }, [fetchVariants]);

  async function handleAddOption() {
    if (!newOptionName.trim() || !newOptionValues.trim()) return;

    const values = newOptionValues.split(',').map(v => ({
      value: v.trim(),
    })).filter(v => v.value);

    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/products/${productId}/options`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            name: newOptionName,
            nameAr: newOptionNameAr || undefined,
            values,
          }),
        }
      );

      if (response.ok) {
        setShowAddOption(false);
        setNewOptionName('');
        setNewOptionNameAr('');
        setNewOptionValues('');
        fetchVariants();
      }
    } catch (error) {
      console.error('Failed to add option:', error);
    }
  }

  async function handleDeleteOption(optionId: string) {
    if (!confirm('Delete this option? This will also delete all variants.')) return;

    try {
      const token = localStorage.getItem('authToken');
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/products/${productId}/options/${optionId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      fetchVariants();
    } catch (error) {
      console.error('Failed to delete option:', error);
    }
  }

  async function handleAddValue(optionId: string) {
    if (!newValue.trim()) return;

    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/products/${productId}/options/${optionId}/values`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            value: newValue,
            valueAr: newValueAr || undefined,
          }),
        }
      );

      if (response.ok) {
        setShowAddValue(null);
        setNewValue('');
        setNewValueAr('');
        fetchVariants();
      }
    } catch (error) {
      console.error('Failed to add value:', error);
    }
  }

  async function handleDeleteValue(valueId: string) {
    if (!confirm('Delete this value? Related variants will also be deleted.')) return;

    try {
      const token = localStorage.getItem('authToken');
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/products/${productId}/option-values/${valueId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      fetchVariants();
    } catch (error) {
      console.error('Failed to delete value:', error);
    }
  }

  async function handleGenerateVariants() {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/products/${productId}/variants/generate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.ok) {
        const data = await response.json();
        alert(`Created ${data.data.result.created} new variants. Total: ${data.data.result.total}`);
        fetchVariants();
      }
    } catch (error) {
      console.error('Failed to generate variants:', error);
    }
  }

  async function handleUpdateVariant() {
    if (!editingVariant) return;

    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/products/${productId}/variants/${editingVariant.id}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            sku: variantForm.sku || null,
            barcode: variantForm.barcode || null,
            price: variantForm.price ? parseInt(variantForm.price) : null,
            compareAtPrice: variantForm.compareAtPrice ? parseInt(variantForm.compareAtPrice) : null,
            costPrice: variantForm.costPrice ? parseInt(variantForm.costPrice) : null,
            inventory: parseInt(variantForm.inventory) || 0,
            weight: variantForm.weight ? parseFloat(variantForm.weight) : null,
          }),
        }
      );

      if (response.ok) {
        setEditingVariant(null);
        fetchVariants();
      }
    } catch (error) {
      console.error('Failed to update variant:', error);
    }
  }

  async function handleDeleteVariant(variantId: string) {
    if (!confirm('Delete this variant?')) return;

    try {
      const token = localStorage.getItem('authToken');
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/products/${productId}/variants/${variantId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      fetchVariants();
    } catch (error) {
      console.error('Failed to delete variant:', error);
    }
  }

  function openEditVariant(variant: Variant) {
    setEditingVariant(variant);
    setVariantForm({
      sku: variant.sku || '',
      barcode: variant.barcode || '',
      price: variant.price?.toString() || '',
      compareAtPrice: variant.compareAtPrice?.toString() || '',
      costPrice: variant.costPrice?.toString() || '',
      inventory: variant.inventory.toString(),
      weight: variant.weight?.toString() || '',
    });
  }

  if (isLoading) {
    return (
      <AdminLayout title="Loading..." subtitle="Please wait">
        <div className="animate-pulse space-y-6">
          <div className="h-24 bg-gray-200 rounded-xl" />
          <div className="h-64 bg-gray-200 rounded-xl" />
        </div>
      </AdminLayout>
    );
  }

  if (!product) {
    return (
      <AdminLayout title="Product Not Found" subtitle="The requested product could not be found">
        <div className="text-center py-12">
          <button
            onClick={() => router.push(`/stores/${storeId}/products`)}
            className="text-primary hover:underline"
          >
            Back to Products
          </button>
        </div>
      </AdminLayout>
    );
  }

  const totalVariantInventory = variants.reduce((sum, v) => sum + v.inventory, 0);

  return (
    <AdminLayout
      title={`Variants: ${product.name}`}
      subtitle="Manage product options and variants"
      actions={
        <Button variant="outline" onClick={() => router.push(`/stores/${storeId}/products`)}>
          <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Products
        </Button>
      }
    >
      {/* Product Summary */}
      <div className="rounded-xl border bg-white p-6 shadow-sm mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-900">{product.name}</h2>
            {product.nameAr && <p className="text-sm text-gray-500" dir="rtl">{product.nameAr}</p>}
            <p className="text-sm text-gray-500 mt-1">Base Price: {formatPrice(product.price)}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-500">Total Variant Stock</p>
            <p className="text-2xl font-bold text-gray-900">{totalVariantInventory}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Options Panel */}
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border bg-white shadow-sm">
            <div className="flex items-center justify-between border-b p-4">
              <h3 className="font-semibold text-gray-900">Options</h3>
              {options.length < 3 && (
                <Button size="sm" onClick={() => setShowAddOption(true)}>
                  Add Option
                </Button>
              )}
            </div>

            {options.length === 0 ? (
              <div className="p-6 text-center text-gray-500">
                <p className="text-sm">No options defined yet.</p>
                <p className="text-xs mt-1">Add options like &quot;Size&quot; or &quot;Color&quot;</p>
              </div>
            ) : (
              <div className="divide-y">
                {options.map(option => (
                  <div key={option.id} className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <p className="font-medium text-gray-900">{option.name}</p>
                        {option.nameAr && (
                          <p className="text-xs text-gray-500" dir="rtl">{option.nameAr}</p>
                        )}
                      </div>
                      <button
                        onClick={() => handleDeleteOption(option.id)}
                        className="text-gray-400 hover:text-red-600"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {option.values.map(value => (
                        <span
                          key={value.id}
                          className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs"
                        >
                          {value.value}
                          <button
                            onClick={() => handleDeleteValue(value.id)}
                            className="text-gray-400 hover:text-red-600"
                          >
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </span>
                      ))}
                      <button
                        onClick={() => setShowAddValue(option.id)}
                        className="inline-flex items-center rounded-full bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                      >
                        + Add
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Generate Variants Button */}
          {options.length > 0 && (
            <Button className="w-full" onClick={handleGenerateVariants}>
              <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Generate All Variants
            </Button>
          )}
        </div>

        {/* Variants Table */}
        <div className="lg:col-span-2 rounded-xl border bg-white shadow-sm">
          <div className="border-b p-4">
            <h3 className="font-semibold text-gray-900">
              Variants ({variants.length})
            </h3>
          </div>

          {variants.length === 0 ? (
            <div className="p-6 text-center text-gray-500">
              <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <p className="mt-2 text-sm">No variants created yet.</p>
              <p className="text-xs">Add options and click &quot;Generate All Variants&quot;</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Variant</th>
                    <th className="px-4 py-3">SKU</th>
                    <th className="px-4 py-3 text-right">Price</th>
                    <th className="px-4 py-3 text-right">Stock</th>
                    <th className="px-4 py-3 text-center">Status</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {variants.map(variant => (
                    <tr key={variant.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{variant.title}</p>
                        {variant.titleAr && (
                          <p className="text-xs text-gray-500" dir="rtl">{variant.titleAr}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {variant.sku || '-'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {variant.price ? formatPrice(variant.price) : (
                          <span className="text-gray-400">Base</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={variant.inventory <= 0 ? 'text-red-600' : ''}>
                          {variant.inventory}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant={variant.isActive ? 'default' : 'secondary'}>
                          {variant.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => openEditVariant(variant)}
                            className="text-gray-400 hover:text-primary"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleDeleteVariant(variant.id)}
                            className="text-gray-400 hover:text-red-600"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
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
      </div>

      {/* Add Option Modal */}
      {showAddOption && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Add Option</h3>

            <div className="space-y-4">
              <div>
                <Label htmlFor="optionName">Option Name</Label>
                <Input
                  id="optionName"
                  value={newOptionName}
                  onChange={e => setNewOptionName(e.target.value)}
                  placeholder="e.g., Size, Color"
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="optionNameAr">Option Name (Arabic)</Label>
                <Input
                  id="optionNameAr"
                  value={newOptionNameAr}
                  onChange={e => setNewOptionNameAr(e.target.value)}
                  placeholder="e.g., المقاس، اللون"
                  dir="rtl"
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="optionValues">Values (comma-separated)</Label>
                <Input
                  id="optionValues"
                  value={newOptionValues}
                  onChange={e => setNewOptionValues(e.target.value)}
                  placeholder="e.g., Small, Medium, Large"
                  className="mt-1"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button variant="outline" onClick={() => setShowAddOption(false)}>
                Cancel
              </Button>
              <Button onClick={handleAddOption}>Add Option</Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Value Modal */}
      {showAddValue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Add Value</h3>

            <div className="space-y-4">
              <div>
                <Label htmlFor="newValue">Value</Label>
                <Input
                  id="newValue"
                  value={newValue}
                  onChange={e => setNewValue(e.target.value)}
                  placeholder="e.g., XL"
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="newValueAr">Value (Arabic)</Label>
                <Input
                  id="newValueAr"
                  value={newValueAr}
                  onChange={e => setNewValueAr(e.target.value)}
                  dir="rtl"
                  className="mt-1"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button variant="outline" onClick={() => setShowAddValue(null)}>
                Cancel
              </Button>
              <Button onClick={() => handleAddValue(showAddValue)}>Add Value</Button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Variant Modal */}
      {editingVariant && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              Edit Variant: {editingVariant.title}
            </h3>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="variantSku">SKU</Label>
                  <Input
                    id="variantSku"
                    value={variantForm.sku}
                    onChange={e => setVariantForm(prev => ({ ...prev, sku: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="variantBarcode">Barcode</Label>
                  <Input
                    id="variantBarcode"
                    value={variantForm.barcode}
                    onChange={e => setVariantForm(prev => ({ ...prev, barcode: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="variantPrice">Price (fils)</Label>
                  <Input
                    id="variantPrice"
                    type="number"
                    value={variantForm.price}
                    onChange={e => setVariantForm(prev => ({ ...prev, price: e.target.value }))}
                    placeholder="Base price"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="variantCompareAt">Compare At</Label>
                  <Input
                    id="variantCompareAt"
                    type="number"
                    value={variantForm.compareAtPrice}
                    onChange={e => setVariantForm(prev => ({ ...prev, compareAtPrice: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="variantCost">Cost</Label>
                  <Input
                    id="variantCost"
                    type="number"
                    value={variantForm.costPrice}
                    onChange={e => setVariantForm(prev => ({ ...prev, costPrice: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="variantInventory">Inventory</Label>
                  <Input
                    id="variantInventory"
                    type="number"
                    value={variantForm.inventory}
                    onChange={e => setVariantForm(prev => ({ ...prev, inventory: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="variantWeight">Weight (kg)</Label>
                  <Input
                    id="variantWeight"
                    type="number"
                    step="0.01"
                    value={variantForm.weight}
                    onChange={e => setVariantForm(prev => ({ ...prev, weight: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button variant="outline" onClick={() => setEditingVariant(null)}>
                Cancel
              </Button>
              <Button onClick={handleUpdateVariant}>Save Changes</Button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
