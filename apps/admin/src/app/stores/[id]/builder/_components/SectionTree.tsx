'use client';

/**
 * Left pane: the page structure — Header group, Template, Footer group — each
 * a sortable list of sections with their blocks (Shopify theme editor shape).
 *
 * Three ways to reorder, all the same reducer action: drag (dnd-kit, with a lifted
 * overlay and a drop line), keyboard (Alt+ArrowUp/Down on a focused row; dnd-kit's
 * own keyboard sensor too), and Move up / Move down in the row menu. A row shows
 * the handle, the name, an eye toggle and an overflow menu (Duplicate, Move, Delete);
 * the actions stay visible on focus-within and on the selected row, never hover-only.
 * Cardinality is enforced by the reducer, which refuses and says why.
 * Logical CSS only (`ps-`, `ms-`, `text-start`), so the tree mirrors in Arabic.
 */
import { Button } from '@/components/ui/Button';
import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  GripVertical,
  Lock,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { RowMenu, type RowMenuItem } from './RowMenu';
import { useLocale } from 'next-intl';
import {
  DndContext,
  closestCenter,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  getSectionDefinition,
  type DocumentAction,
  type PageDefinition,
  type SectionList,
  type SectionNode,
  isSectionPageKind,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { useIsCanvasHovered } from '../_lib/canvas-hover-store';

export interface Selection {
  sectionId: string;
  blockId?: string;
}

interface Props {
  doc: PageDefinition;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  /** Enter on a row: select it and hand keyboard focus to its first target on the canvas. */
  onFocusCanvas?: (s: Selection) => void;
  dispatch: (a: DocumentAction) => void;
  /** `index` = insert at that position (the insert line between rows); omitted = at the end. */
  onAddSection: (list: SectionList, index?: number) => void;
}

function label(node: SectionNode, locale: string): string {
  const d = getSectionDefinition(node.type);
  if (!d) return node.type;
  return locale === 'ar' ? d.labelAr : d.labelEn;
}

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Every icon in the tree: one stroke weight, from the icon set the admin already uses. */
const ICON = 'h-4 w-4';
const STROKE = 1.75;

function Row({
  node,
  index,
  count,
  selection,
  onSelect,
  onFocusCanvas,
  dispatch,
  dropLine,
}: {
  node: SectionNode;
  index: number;
  count: number;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  onFocusCanvas?: (s: Selection) => void;
  dispatch: (a: DocumentAction) => void;
  dropLine?: 'before' | 'after' | null;
}) {
  const t = useT('builder.tree');
  const locale = useLocale();
  // A canvas hover is not editor state: only the row whose highlight flips re-renders.
  const hovered = useIsCanvasHovered(node.id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.id,
  });
  const d = getSectionDefinition(node.type);
  const selected = selection?.sectionId === node.id && !selection.blockId;
  const name = label(node, locale);
  const blockDef = d?.blocks[0];
  // The core of a product / collection / cart page: it moves, it is never hidden or removed.
  const pinned = d?.pinned === true;
  const menuItems: RowMenuItem[] = [
    ...(d?.cardinality === 'many'
      ? [
          {
            label: t('duplicateItem'),
            icon: <Copy className={ICON} strokeWidth={STROKE} />,
            onSelect: () => dispatch({ type: 'duplicateSection', id: node.id }),
          },
        ]
      : []),
    {
      label: t('moveUpItem'),
      icon: <ArrowUp className={ICON} strokeWidth={STROKE} />,
      disabled: index === 0,
      onSelect: () => dispatch({ type: 'moveSection', id: node.id, toIndex: index - 1 }),
    },
    {
      label: t('moveDownItem'),
      icon: <ArrowDown className={ICON} strokeWidth={STROKE} />,
      disabled: index === count - 1,
      onSelect: () => dispatch({ type: 'moveSection', id: node.id, toIndex: index + 1 }),
    },
    ...(pinned
      ? []
      : [
          {
            label: t('removeItem'),
            icon: <Trash2 className={ICON} strokeWidth={STROKE} />,
            destructive: true,
            onSelect: () => dispatch({ type: 'removeSection', id: node.id }),
          },
        ]),
  ];

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: reducedMotion() ? undefined : transition,
      }}
      className={`relative ${isDragging ? 'opacity-40' : ''}`}
      data-testid={`tree-row-${node.id}`}
    >
      {dropLine && (
        <span
          aria-hidden="true"
          data-testid="tree-drop-line"
          className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary ${
            dropLine === 'before' ? '-top-0.5' : '-bottom-0.5'
          }`}
        />
      )}
      <div
        data-selected={selected ? 'true' : undefined}
        className={`group relative flex min-h-9 items-center gap-1 rounded-lg ps-1 pe-1 text-sm ${
          selected
            ? 'bg-primary/10 text-foreground before:absolute before:inset-y-1.5 before:start-0 before:w-0.5 before:rounded-full before:bg-primary'
            : hovered
              ? 'bg-muted'
              : 'hover:bg-muted'
        }`}
      >
        <button
          data-ui="handle"
          type="button"
          className="flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          aria-label={t('drag', { name })}
          {...attributes}
          {...listeners}
        >
          <GripVertical className={ICON} strokeWidth={STROKE} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`min-w-0 flex-1 truncate text-start ${node.hidden ? 'text-muted-foreground opacity-70' : ''}`}
          onClick={() => onSelect({ sectionId: node.id })}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.altKey && onFocusCanvas) {
              e.preventDefault();
              onSelect({ sectionId: node.id });
              onFocusCanvas({ sectionId: node.id });
              return;
            }
            if (!e.altKey) return;
            if (e.key === 'ArrowUp' && index > 0) {
              e.preventDefault();
              dispatch({ type: 'moveSection', id: node.id, toIndex: index - 1 });
            }
            if (e.key === 'ArrowDown' && index < count - 1) {
              e.preventDefault();
              dispatch({ type: 'moveSection', id: node.id, toIndex: index + 1 });
            }
          }}
          aria-current={selected ? 'true' : undefined}
          data-testid={`tree-select-${node.id}`}
        >
          {name}
        </button>
        {node.hidden && (
          <span
            data-testid={`tree-hidden-${node.id}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            <EyeOff className="h-3 w-3" strokeWidth={STROKE} aria-hidden="true" />
            {t('hiddenTag')}
          </span>
        )}
        {pinned && (
          <span
            role="img"
            aria-label={t('pinned', { name })}
            title={t('pinned', { name })}
            className="flex h-8 w-6 shrink-0 items-center justify-center text-muted-foreground"
            data-testid={`tree-pinned-${node.id}`}
          >
            <Lock className="h-3.5 w-3.5" strokeWidth={STROKE} aria-hidden="true" />
          </span>
        )}
        <span
          data-testid={`tree-actions-${node.id}`}
          className={`flex shrink-0 items-center transition-opacity duration-150 motion-reduce:transition-none group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 ${
            selected || node.hidden ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {!pinned && (
            <IconButton
              label={node.hidden ? t('show', { name }) : t('hide', { name })}
              onClick={() =>
                dispatch({ type: 'setSectionHidden', id: node.id, hidden: !node.hidden })
              }
            >
              {node.hidden ? (
                <EyeOff className={ICON} strokeWidth={STROKE} />
              ) : (
                <Eye className={ICON} strokeWidth={STROKE} />
              )}
            </IconButton>
          )}
          <RowMenu label={t('options', { name })} items={menuItems} />
        </span>
      </div>
      {(node.blocks?.length || blockDef) && (
        <ul className="ms-6 mt-0.5 space-y-0.5 border-s border-border ps-2">
          {(node.blocks ?? []).map((b, bi) => {
            const bSelected = selection?.sectionId === node.id && selection.blockId === b.id;
            const bName = `${locale === 'ar' ? blockDef?.labelAr : blockDef?.labelEn} ${bi + 1}`;
            return (
              <li
                key={b.id}
                className="group/block flex items-center gap-1"
                data-testid={`tree-block-${node.id}-${b.id}`}
              >
                <button
                  data-ui="row"
                  type="button"
                  onClick={() => onSelect({ sectionId: node.id, blockId: b.id })}
                  onKeyDown={e => {
                    if (e.key !== 'Enter' || !onFocusCanvas) return;
                    e.preventDefault();
                    onSelect({ sectionId: node.id, blockId: b.id });
                    onFocusCanvas({ sectionId: node.id, blockId: b.id });
                  }}
                  className={`relative flex min-h-8 min-w-0 flex-1 items-center gap-1.5 truncate rounded-md px-2 py-1 text-start text-xs ${
                    bSelected
                      ? 'bg-primary/10 before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-primary'
                      : 'hover:bg-muted'
                  } ${b.hidden ? 'text-muted-foreground opacity-70' : ''}`}
                >
                  <span className="truncate">{bName}</span>
                  {b.hidden && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 text-xs text-muted-foreground">
                      <EyeOff className="h-3 w-3" strokeWidth={STROKE} aria-hidden="true" />
                      {t('hiddenTag')}
                    </span>
                  )}
                </button>
                <span
                  className={`flex shrink-0 items-center group-focus-within/block:opacity-100 group-hover/block:opacity-100 [@media(hover:none)]:opacity-100 ${
                    bSelected || b.hidden ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <IconButton
                    label={t('moveUp', { name: bName })}
                    disabled={bi === 0}
                    onClick={() =>
                      dispatch({
                        type: 'moveBlock',
                        sectionId: node.id,
                        blockId: b.id,
                        toIndex: bi - 1,
                      })
                    }
                  >
                    <ChevronUp className={ICON} strokeWidth={STROKE} />
                  </IconButton>
                  <IconButton
                    label={b.hidden ? t('show', { name: bName }) : t('hide', { name: bName })}
                    onClick={() =>
                      dispatch({
                        type: 'setBlockHidden',
                        sectionId: node.id,
                        blockId: b.id,
                        hidden: !b.hidden,
                      })
                    }
                  >
                    {b.hidden ? (
                      <EyeOff className={ICON} strokeWidth={STROKE} />
                    ) : (
                      <Eye className={ICON} strokeWidth={STROKE} />
                    )}
                  </IconButton>
                  <IconButton
                    label={t('remove', { name: bName })}
                    onClick={() =>
                      dispatch({ type: 'removeBlock', sectionId: node.id, blockId: b.id })
                    }
                  >
                    <X className={ICON} strokeWidth={STROKE} />
                  </IconButton>
                </span>
              </li>
            );
          })}
          {blockDef && (
            <li>
              <Button
                variant="link"
                size="sm"
                type="button"
                onClick={() =>
                  dispatch({ type: 'addBlock', sectionId: node.id, blockType: blockDef.type })
                }
              >
                {t('addBlock', { name: locale === 'ar' ? blockDef.labelAr : blockDef.labelEn })}
              </Button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="text-muted-foreground"
    >
      <span aria-hidden="true">{children}</span>
    </Button>
  );
}

/** A thin insert affordance between two rows: appears on hover or keyboard focus. */
function InsertLine({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <li role="presentation" className="relative h-0.5" data-testid="tree-insert-line">
      <button
        type="button"
        data-ui="row"
        aria-label={label}
        title={label}
        onClick={onClick}
        className="group/insert absolute inset-x-1 -top-1.5 z-10 flex h-3.5 items-center opacity-0 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none [@media(hover:none)]:hidden"
      >
        <span className="h-px flex-1 bg-primary" />
        <span className="mx-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Plus className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        </span>
        <span className="h-px flex-1 bg-primary" />
      </button>
    </li>
  );
}

function Group({
  list,
  title,
  nodes,
  ...rest
}: Omit<Props, 'doc'> & { list: SectionList; title: string; nodes: SectionNode[] }) {
  const t = useT('builder.tree');
  const locale = useLocale();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const end = () => {
    setActiveId(null);
    setOverId(null);
  };
  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragOver = (e: DragOverEvent) => setOverId(e.over ? String(e.over.id) : null);
  const onDragEnd = (e: DragEndEvent) => {
    end();
    if (!e.over || e.active.id === e.over.id) return;
    const to = nodes.findIndex(n => n.id === e.over!.id);
    if (to >= 0) rest.dispatch({ type: 'moveSection', id: String(e.active.id), toIndex: to });
  };
  const activeIndex = nodes.findIndex(n => n.id === activeId);
  const overIndex = nodes.findIndex(n => n.id === overId);
  const lineFor = (id: string): 'before' | 'after' | null =>
    activeId && overId && activeId !== overId && id === overId && activeIndex >= 0
      ? activeIndex < overIndex
        ? 'after'
        : 'before'
      : null;
  const active = nodes.find(n => n.id === activeId);
  const addButton = (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onClick={() => rest.onAddSection(list)}
      className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
      data-testid={`add-section-${list}`}
      data-setting-id="builder.add-section"
    >
      <Plus className={ICON} strokeWidth={STROKE} aria-hidden="true" />
      {t('addSection')}
    </Button>
  );
  return (
    <section aria-label={title} className="mb-4" data-testid={`tree-group-${list}`}>
      <h2 className="mb-1 px-2 text-sm font-semibold text-muted-foreground">{title}</h2>
      {nodes.length === 0 ? (
        <div
          className="rounded-lg border border-dashed border-border px-3 py-4 text-center"
          data-testid={`tree-empty-${list}`}
        >
          <p className="mb-2 text-sm text-muted-foreground">{t(`empty.${list}`)}</p>
          {addButton}
        </div>
      ) : (
        <>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={end}
          >
            <SortableContext items={nodes.map(n => n.id)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-0.5">
                {nodes.flatMap((n, i) => [
                  ...(i > 0
                    ? [
                        <InsertLine
                          key={`ins-${n.id}`}
                          label={t('insertHere')}
                          onClick={() => rest.onAddSection(list, i)}
                        />,
                      ]
                    : []),
                  <Row
                    key={n.id}
                    node={n}
                    index={i}
                    count={nodes.length}
                    dropLine={lineFor(n.id)}
                    {...rest}
                  />,
                ])}
              </ul>
            </SortableContext>
            <DragOverlay
              dropAnimation={
                reducedMotion() ? null : { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
              }
            >
              {active ? (
                <div
                  data-testid="tree-drag-overlay"
                  className="flex min-h-9 items-center gap-1 rounded-lg border border-border bg-card ps-1 pe-3 text-sm shadow-lg"
                >
                  <span className="flex h-8 w-6 items-center justify-center text-muted-foreground">
                    <GripVertical className={ICON} strokeWidth={STROKE} aria-hidden="true" />
                  </span>
                  <span className="truncate">{label(active, locale)}</span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
          <div className="mt-1 border-t border-border/60 pt-1">{addButton}</div>
        </>
      )}
    </section>
  );
}

export function SectionTree({ doc, ...rest }: Props) {
  const t = useT('builder.tree');
  const sectionsOnly = isSectionPageKind(doc.pageKey);
  const sel = rest.selection;
  // A click on the canvas selects here too: bring the row into view.
  useEffect(() => {
    if (!sel) return;
    const testId = sel.blockId
      ? `tree-block-${sel.sectionId}-${sel.blockId}`
      : `tree-row-${sel.sectionId}`;
    document
      .querySelector(`[data-testid="${window.CSS.escape(testId)}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [sel?.sectionId, sel?.blockId]); // eslint-disable-line react-hooks/exhaustive-deps -- the ids are the identity
  return (
    <nav aria-label={t('label')} className="p-2">
      {/* a product / collection / cart page holds sections only: the header and footer belong to every page */}
      {!sectionsOnly && (
        <Group list="header" title={t('header')} nodes={doc.sectionGroups.header} {...rest} />
      )}
      <Group list="template" title={t('template')} nodes={doc.sections} {...rest} />
      {!sectionsOnly && (
        <Group list="footer" title={t('footer')} nodes={doc.sectionGroups.footer} {...rest} />
      )}
    </nav>
  );
}
