'use client';

interface Category {
  id: string;
  name: string;
  nameAr: string | null;
  slug: string;
  description: string | null;
  descriptionAr: string | null;
  image: string | null;
  isActive: boolean;
  sortOrder: number;
  _count?: { products: number };
}

interface CategoryTableProps {
  categories: Category[];
  isLoading: boolean;
  deletingId: string | null;
  onEdit: (category: Category) => void;
  onDelete: (category: { id: string; name: string }) => void;
  onAddFirst: () => void;
}

export type { Category };

export function CategoryTable({
  categories,
  isLoading,
  deletingId,
  onEdit,
  onDelete,
  onAddFirst,
}: CategoryTableProps) {
  if (isLoading) {
    return (
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
    );
  }

  if (categories.length === 0) {
    return (
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
        <button onClick={onAddFirst} className="mt-4 text-sm text-primary hover:underline">
          Add your first category
        </button>
      </div>
    );
  }

  return (
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
                <div className="flex items-center gap-3">
                  {cat.image ? (
                    <img
                      src={cat.image}
                      alt={cat.name}
                      className="h-10 w-10 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary font-semibold">
                      {cat.name.charAt(0)}
                    </div>
                  )}
                  <div>
                    <p className="font-medium text-gray-900">{cat.name}</p>
                    {cat.nameAr && <p className="text-sm text-gray-500">{cat.nameAr}</p>}
                    {cat.description && (
                      <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{cat.description}</p>
                    )}
                  </div>
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
                    cat.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'
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
                    onClick={() => onEdit(cat)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete({ id: cat.id, name: cat.name })}
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
  );
}
