'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useToast } from '@ebda/ui';
import { Button, buttonVariants } from '@/components/ui/Button';
import { useLocale } from 'next-intl';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../../../lib/api';
import { useT } from '@/i18n/useT';
import { useDndA11y } from '@/hooks/useDndA11y';

interface ProductRow {
  id: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  status: string;
  position: number;
  images: { url: string }[];
}

interface CategoryMeta {
  id: string;
  name: string;
  nameAr: string | null;
}

// ---------------------------------------------------------------------------
// Grip icon — the visible drag handle
// ---------------------------------------------------------------------------
function GripIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <circle cx="5" cy="4" r="1.2" />
      <circle cx="11" cy="4" r="1.2" />
      <circle cx="5" cy="8" r="1.2" />
      <circle cx="11" cy="8" r="1.2" />
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="11" cy="12" r="1.2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sortable product row
// ---------------------------------------------------------------------------
interface SortableProductRowProps {
  product: ProductRow;
  idx: number;
  isRtl: boolean;
  isSaving: boolean;
  t: (key: string, values?: Record<string, string | number>) => string;
}

function SortableProductRow({ product, idx, isRtl, isSaving, t }: SortableProductRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: product.id,
    disabled: isSaving,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: isDragging ? 'relative' : undefined,
  };

  const displayName = isRtl ? product.nameAr || product.name : product.name || product.nameAr || '';
  const altName = isRtl ? product.name : product.nameAr;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors bg-card"
    >
      {/* Drag handle */}
      <span
        {...attributes}
        {...listeners}
        className={buttonVariants({
          variant: 'ghost',
          size: 'icon-sm',
          className:
            'cursor-grab touch-none text-muted-foreground/60 hover:text-muted-foreground active:cursor-grabbing',
        })}
        aria-label={t('dragHandle')}
        title={t('dragHandle')}
      >
        <GripIcon className="h-4 w-4" />
      </span>

      {/* Position badge */}
      <span className="flex-shrink-0 w-6 text-center text-xs font-mono text-muted-foreground">
        {idx + 1}
      </span>

      {/* Thumbnail */}
      {product.images[0]?.url ? (
        <Image
          src={product.images[0].url}
          alt={displayName}
          width={48}
          height={48}
          className="h-12 w-12 rounded-lg object-cover flex-shrink-0"
        />
      ) : (
        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary-ink font-semibold text-sm">
          {displayName.charAt(0)}
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="truncate font-medium text-sm text-foreground">{displayName}</p>
        {altName && <p className="truncate text-xs text-muted-foreground">{altName}</p>}
        <div className="mt-0.5 flex items-center gap-2">
          {product.sku && (
            <span className="font-mono text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {t('sku', { sku: product.sku })}
            </span>
          )}
          {product.status !== 'active' && (
            <span className="text-xs text-muted-foreground">{t('inactive')}</span>
          )}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function CategoryProductOrderPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const categoryId = params?.categoryId as string;
  const t = useT('categories.productOrder');
  const locale = useLocale();
  const isRtl = locale === 'ar';

  const [category, setCategory] = useState<CategoryMeta | null>(null);
  const [products, setProducts] = useState<ProductRow[]>([]);
  // Hide non-active products from the reorder view by default — merchants reorder
  // what shows on the storefront. The FULL order (incl. inactive) is always what
  // we persist, so hiding never loses an inactive product's slot.
  const [activeOnly, setActiveOnly] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { success: toastSuccess, error: showError } = useToast();

  const dndA11y = useDndA11y();
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        // Require 8px movement before drag starts — lets taps/clicks pass through
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const fetchProducts = useCallback(async () => {
    if (!storeId || !categoryId) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<{
        category: CategoryMeta;
        products: ProductRow[];
      }>(`/api/v1/stores/${storeId}/categories/${categoryId}/products`);
      if (apiError) {
        setError(apiError.message || t('fetchFailed'));
      } else if (data) {
        setCategory(data.category);
        setProducts(data.products);
      }
    } catch {
      setError(t('connectionError'));
    } finally {
      setIsLoading(false);
    }
  }, [storeId, categoryId, t]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // Products shown in the list. When activeOnly is on, inactive rows are hidden
  // from view but stay pinned in the persisted order (see handleDragEnd).
  const displayedProducts = activeOnly ? products.filter(p => p.status === 'active') : products;
  const hiddenCount = products.length - displayedProducts.length;

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setProducts(prev => {
      if (!activeOnly) {
        const oldIndex = prev.findIndex(p => p.id === active.id);
        const newIndex = prev.findIndex(p => p.id === over.id);
        return arrayMove(prev, oldIndex, newIndex);
      }
      // Active-only view: reorder within the visible (active) subset, then
      // rebuild the FULL order with every inactive product kept exactly where it
      // was (its absolute slot), so hiding/reordering never drops or moves an
      // inactive product on save.
      const visible = prev.filter(p => p.status === 'active');
      const oldIndex = visible.findIndex(p => p.id === active.id);
      const newIndex = visible.findIndex(p => p.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const reordered = arrayMove(visible, oldIndex, newIndex);
      let ai = 0;
      return prev.map(p => (p.status === 'active' ? reordered[ai++] : p));
    });
    setIsDirty(true);
  }

  async function saveOrder() {
    if (!storeId || !categoryId || !isDirty) return;
    setIsSaving(true);
    try {
      const { error: apiError } = await apiPut(
        `/api/v1/stores/${storeId}/categories/${categoryId}/products/reorder`,
        { orderedProductIds: products.map(p => p.id) }
      );
      if (apiError) {
        showError(t('saveFailed'), apiError.message ?? '');
      } else {
        toastSuccess(t('saveSuccess'));
        setIsDirty(false);
      }
    } catch {
      showError(t('saveFailed'), t('connectionError'));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <AdminLayout
      title={
        category
          ? `${t('title')} — ${isRtl ? category.nameAr || category.name : category.name || category.nameAr || ''}`
          : t('title')
      }
      subtitle={t('subtitle')}
      actions={
        <div className="flex gap-2">
          <Link href={`/stores/${storeId}/categories`}>
            <Button type="button" variant="outline">
              {t('backToCategories')}
            </Button>
          </Link>
          <Button
            type="button"
            onClick={saveOrder}
            disabled={!isDirty || isSaving}
            isLoading={isSaving}
          >
            {isSaving ? t('saving') : t('save')}
          </Button>
        </div>
      }
    >
      {error && (
        <div className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-ink">
          {error}
          <button type="button" className="ms-4 font-medium underline" onClick={fetchProducts}>
            {t('backToCategories')}
          </button>
        </div>
      )}

      {!isLoading && products.length > 0 && (
        <div className="mb-4 flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={e => setActiveOnly(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            {t('activeOnly')}
          </label>
          {activeOnly && hiddenCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('hiddenInactive', { count: hiddenCount })}
            </span>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3 rounded-xl border bg-card p-6 shadow-sm">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 animate-pulse">
              <div className="h-4 w-4 rounded bg-muted" />
              <div className="h-12 w-12 rounded-lg bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-40 rounded bg-muted" />
                <div className="h-3 w-24 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : products.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 shadow-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
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
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          </div>
          <p className="font-semibold text-foreground">{t('empty')}</p>
          <p className="mt-1 max-w-md mx-auto text-sm text-muted-foreground">
            {t('emptyDescription')}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          {isDirty && (
            <div className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning-ink">
              {t('unsavedChanges')}
            </div>
          )}
          <DndContext
            {...dndA11y}
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={displayedProducts.map(p => p.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="divide-y divide-border" role="list" aria-label={t('title')}>
                {displayedProducts.map((product, idx) => (
                  <SortableProductRow
                    key={product.id}
                    product={product}
                    idx={idx}
                    isRtl={isRtl}
                    isSaving={isSaving}
                    t={t}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>

          <div className="border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
            {t('productCount', { count: products.length })}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
