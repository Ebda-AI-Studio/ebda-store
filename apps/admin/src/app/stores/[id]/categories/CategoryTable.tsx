'use client';

import Image from 'next/image';
import { useLocale } from 'next-intl';
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
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useT } from '@/i18n/useT';
import { RowActions } from '@/components/RowActions';

import { Button, buttonVariants } from '@/components/ui/Button';
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
  storeId: string;
  onEdit: (category: Category) => void;
  onDelete: (category: { id: string; name: string }) => void;
  onAddFirst: () => void;
  /** Called when the user finishes a drag-reorder. The page persists the new
   *  order. When omitted (e.g. while a search filter is active), the drag
   *  handles are hidden. */
  onDragEnd?: (event: DragEndEvent) => void;
  /** When true, the drag handles are visually disabled (save in flight). */
  reordering?: boolean;
}

export type { Category };

// ---------------------------------------------------------------------------
// Grip icon
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
// Sortable table row
// ---------------------------------------------------------------------------
interface SortableCategoryRowProps {
  cat: Category;
  isRtl: boolean;
  deletingId: string | null;
  storeId: string;
  reordering: boolean;
  showDragHandle: boolean;
  onEdit: (cat: Category) => void;
  onDelete: (cat: { id: string; name: string }) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
  tOrder: (key: string) => string;
}

function SortableCategoryRow({
  cat,
  isRtl,
  deletingId,
  storeId,
  reordering,
  showDragHandle,
  onEdit,
  onDelete,
  t,
  tOrder,
}: SortableCategoryRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cat.id,
    disabled: !showDragHandle || reordering,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: isDragging ? 'relative' : undefined,
  };

  const displayName = isRtl ? cat.nameAr || cat.name : cat.name || cat.nameAr || '';
  const altName = isRtl ? cat.name : cat.nameAr;

  return (
    <tr ref={setNodeRef} style={style} className="hover:bg-muted transition-colors">
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          {/* Drag handle — only rendered when reordering is active */}
          {showDragHandle && (
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
          )}
          {cat.image ? (
            <Image
              src={cat.image}
              alt={displayName}
              width={40}
              height={40}
              className="h-10 w-10 rounded-lg object-cover"
            />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary-ink font-semibold">
              {displayName.charAt(0)}
            </div>
          )}
          <div>
            <p className="font-medium text-foreground">{displayName}</p>
            {altName && <p className="text-sm text-muted-foreground">{altName}</p>}
            {!cat.nameAr?.trim() && (
              <span className="mt-1 inline-flex rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-ink">
                {t('missingArabicName')}
              </span>
            )}
            {cat.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{cat.description}</p>
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
        <span className="text-sm font-medium text-foreground">{cat._count?.products ?? 0}</span>
      </td>
      <td className="px-6 py-4 hidden md:table-cell">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
            cat.isActive
              ? 'bg-success/10 text-success-ink dark:bg-success/20 dark:text-success-ink'
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
          <RowActions
            menuLabel={t('rowMenu', { name: displayName })}
            primary={
              <Button type="button" onClick={() => onEdit(cat)} variant="outline">
                {t('edit')}
              </Button>
            }
            items={[
              ...((cat._count?.products ?? 0) > 1
                ? [
                    {
                      label: tOrder('title'),
                      href: `/stores/${storeId}/categories/${cat.id}/order`,
                    },
                  ]
                : []),
              {
                label: deletingId === cat.id ? t('deleting') : t('delete'),
                destructive: true,
                disabled: deletingId === cat.id,
                onSelect: () =>
                  onDelete({
                    id: cat.id,
                    name: isRtl ? cat.nameAr || cat.name : cat.name || cat.nameAr || cat.name,
                  }),
              },
            ]}
          />
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// CategoryTable
// ---------------------------------------------------------------------------
export function CategoryTable({
  categories,
  isLoading,
  deletingId,
  storeId,
  onEdit,
  onDelete,
  onAddFirst,
  onDragEnd,
  reordering = false,
}: CategoryTableProps) {
  const t = useT('categories.table');
  const tOrder = useT('categories.productOrder');
  const locale = useLocale();
  const isRtl = locale === 'ar';

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        // 8px movement required — lets taps and click interactions pass through
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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
        <Button type="button" onClick={onAddFirst} variant="default" className="mt-4 font-semibold">
          {t('addFirst')}
        </Button>
      </div>
    );
  }

  const showDragHandle = !!onDragEnd;

  // Below md the table becomes a card per category (UX:M-2); drag-reorder stays a desktop affordance.
  const mobileCards = (
    <ul className="divide-y divide-border md:hidden" aria-label={t('label')}>
      {categories.map(cat => {
        const name = isRtl ? cat.nameAr || cat.name : cat.name || cat.nameAr || '';
        const altName = isRtl ? cat.name : cat.nameAr;
        return (
          <li key={cat.id} className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-foreground">{name}</p>
                {altName && <p className="text-sm text-muted-foreground">{altName}</p>}
                {!cat.nameAr?.trim() && (
                  <span className="mt-1 inline-flex rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-ink">
                    {t('missingArabicName')}
                  </span>
                )}
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                  cat.isActive ? 'bg-success/10 text-success-ink' : 'bg-muted text-muted-foreground'
                }`}
              >
                {cat.isActive ? t('active') : t('inactive')}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('products')}: {cat._count?.products ?? 0}
            </p>
            <RowActions
              menuLabel={t('rowMenu', { name })}
              primary={
                <Button type="button" onClick={() => onEdit(cat)} variant="outline">
                  {t('edit')}
                </Button>
              }
              items={[
                ...((cat._count?.products ?? 0) > 1
                  ? [
                      {
                        label: tOrder('title'),
                        href: `/stores/${storeId}/categories/${cat.id}/order`,
                      },
                    ]
                  : []),
                {
                  label: deletingId === cat.id ? t('deleting') : t('delete'),
                  destructive: true,
                  disabled: deletingId === cat.id,
                  onSelect: () => onDelete({ id: cat.id, name }),
                },
              ]}
            />
          </li>
        );
      })}
    </ul>
  );

  const tableBody = (
    <div className="hidden overflow-x-auto md:block">
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
          {categories.map(cat => (
            <SortableCategoryRow
              key={cat.id}
              cat={cat}
              isRtl={isRtl}
              deletingId={deletingId}
              storeId={storeId}
              reordering={reordering}
              showDragHandle={showDragHandle}
              onEdit={onEdit}
              onDelete={onDelete}
              t={t}
              tOrder={tOrder}
            />
          ))}
        </tbody>
      </table>
    </div>
  );

  if (!onDragEnd) {
    return (
      <>
        {mobileCards}
        {tableBody}
      </>
    );
  }

  return (
    <>
      {mobileCards}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={categories.map(c => c.id)} strategy={verticalListSortingStrategy}>
          {tableBody}
        </SortableContext>
      </DndContext>
    </>
  );
}
