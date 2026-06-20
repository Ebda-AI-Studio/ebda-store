'use client';

import Image from 'next/image';
import { useT } from '@/i18n/useT';

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
  /** Move a category one step up/down. The page persists the new order. When
   *  omitted (or while a save is in flight), the move controls are hidden. */
  onMove?: (id: string, direction: 'up' | 'down') => void;
  reordering?: boolean;
}

export type { Category };

export function CategoryTable({
  categories,
  isLoading,
  deletingId,
  onEdit,
  onDelete,
  onAddFirst,
  onMove,
  reordering = false,
}: CategoryTableProps) {
  const t = useT('categories.table');
  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 animate-pulse">
            <div className="h-10 w-10 rounded-xl bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-32 rounded bg-muted" />
              <div className="h-3 w-20 rounded bg-muted" />
            </div>
            <div className="h-8 w-20 rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (categories.length === 0) {
    return (
      <div className="force-empty-state px-6">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
          <svg
            className="h-8 w-8 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
            />
          </svg>
        </div>
        <p className="font-semibold text-foreground">{t('empty')}</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{t('emptyDescription')}</p>
        <button
          type="button"
          onClick={onAddFirst}
          className="mt-4 inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
        >
          {t('addFirst')}
        </button>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full" aria-label={t('label')}>
        <thead className="bg-muted border-b">
          <tr>
            <th
              scope="col"
              className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('category')}
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('slug')}
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('products')}
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell"
            >
              {t('status')}
            </th>
            <th
              scope="col"
              className="px-6 py-3 text-end text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              {t('actions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {categories.map((cat, idx) => (
            <tr key={cat.id} className="hover:bg-muted transition-colors">
              <td className="px-6 py-4">
                <div className="flex items-center gap-3">
                  {cat.image ? (
                    <Image
                      src={cat.image}
                      alt={cat.name}
                      width={40}
                      height={40}
                      className="h-10 w-10 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary font-semibold">
                      {cat.name.charAt(0)}
                    </div>
                  )}
                  <div>
                    <p className="font-medium text-foreground">{cat.name}</p>
                    {cat.nameAr && <p className="text-sm text-muted-foreground">{cat.nameAr}</p>}
                    {cat.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                        {cat.description}
                      </p>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-6 py-4">
                <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                  {cat.slug}
                </span>
              </td>
              <td className="px-6 py-4">
                <span className="text-sm font-medium text-foreground">
                  {cat._count?.products ?? 0}
                </span>
              </td>
              <td className="px-6 py-4 hidden md:table-cell">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                    cat.isActive
                      ? 'bg-success/10 text-success dark:bg-success/20 dark:text-success'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${cat.isActive ? 'bg-success' : 'bg-muted-foreground'}`}
                  />
                  {cat.isActive ? t('active') : t('inactive')}
                </span>
              </td>
              <td className="px-6 py-4 text-end">
                <div className="flex items-center justify-end gap-2">
                  {onMove && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onMove(cat.id, 'up')}
                        disabled={idx === 0 || reordering}
                        aria-label={t('moveUp')}
                        title={t('moveUp')}
                        className="grid h-7 w-7 place-items-center rounded-lg border border-border text-foreground hover:bg-muted transition-colors disabled:opacity-30"
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 15l7-7 7 7"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => onMove(cat.id, 'down')}
                        disabled={idx === categories.length - 1 || reordering}
                        aria-label={t('moveDown')}
                        title={t('moveDown')}
                        className="grid h-7 w-7 place-items-center rounded-lg border border-border text-foreground hover:bg-muted transition-colors disabled:opacity-30"
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 9l-7 7-7-7"
                          />
                        </svg>
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => onEdit(cat)}
                    className="px-3 py-1.5 text-xs font-medium text-foreground border border-border rounded-lg hover:bg-muted transition-colors"
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete({ id: cat.id, name: cat.name })}
                    disabled={deletingId === cat.id}
                    className="px-3 py-1.5 text-xs font-medium text-destructive border border-destructive/30 rounded-lg hover:bg-destructive/5 transition-colors disabled:opacity-50"
                  >
                    {deletingId === cat.id ? t('deleting') : t('delete')}
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
