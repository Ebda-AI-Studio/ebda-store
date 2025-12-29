'use client';

import { useState } from 'react';

interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  productCount: number;
}

// Initial mock data - in production would fetch from API
const mockCategories: Category[] = [
  { id: '1', name: 'Electronics', slug: 'electronics', description: 'Electronic devices and gadgets', productCount: 45 },
  { id: '2', name: 'Clothing', slug: 'clothing', description: 'Fashion and apparel', productCount: 120 },
  { id: '3', name: 'Home & Garden', slug: 'home-garden', description: 'Home improvement and garden supplies', productCount: 78 },
];

export default function CategoriesPage() {
  const [categories] = useState<Category[]>(mockCategories);
  const loading = false;

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Categories</h1>
        <button className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">
          Add Category
        </button>
      </div>

      {loading ? (
        <div className="text-center py-8">Loading...</div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Slug</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Products</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {categories.map((category) => (
                <tr key={category.id}>
                  <td className="px-6 py-4 whitespace-nowrap font-medium">{category.name}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-500">{category.slug}</td>
                  <td className="px-6 py-4 text-gray-500">{category.description || '-'}</td>
                  <td className="px-6 py-4 whitespace-nowrap">{category.productCount}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <button className="text-blue-600 hover:text-blue-800 mr-3">Edit</button>
                    <button className="text-red-600 hover:text-red-800">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
