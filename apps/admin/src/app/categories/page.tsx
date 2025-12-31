'use client';

import { useState } from 'react';
import { Button } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';

interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  productCount: number;
}

// Initial mock data - in production would fetch from API
const mockCategories: Category[] = [
  {
    id: '1',
    name: 'Electronics',
    slug: 'electronics',
    description: 'Electronic devices and gadgets',
    productCount: 45,
  },
  {
    id: '2',
    name: 'Clothing',
    slug: 'clothing',
    description: 'Fashion and apparel',
    productCount: 120,
  },
  {
    id: '3',
    name: 'Home & Garden',
    slug: 'home-garden',
    description: 'Home improvement and garden supplies',
    productCount: 78,
  },
];

export default function CategoriesPage() {
  const [categories] = useState<Category[]>(mockCategories);
  const loading = false;

  return (
    <AdminLayout
      title="Categories"
      subtitle="Manage product categories across all stores"
      actions={
        <Button size="sm">
          <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Category
        </Button>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Slug
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Description
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
                  <td className="px-6 py-4 whitespace-nowrap font-medium">{category.name}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-500 font-mono text-sm">
                    {category.slug}
                  </td>
                  <td className="px-6 py-4 text-gray-500">{category.description || '-'}</td>
                  <td className="px-6 py-4 whitespace-nowrap">{category.productCount}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <button className="text-primary hover:text-primary/80 mr-3">Edit</button>
                    <button className="text-red-600 hover:text-red-800">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminLayout>
  );
}
