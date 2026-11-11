'use client';

/**
 * Left pane: the page structure — Header group, Template, Footer group — each
 * a sortable list of sections with their blocks (Shopify theme editor shape).
 *
 * Three ways to reorder, all the same reducer action: drag (dnd-kit, already
 * a dependency), keyboard (Alt+ArrowUp/Down on a focused row; dnd-kit's own
 * keyboard sensor too), and the move buttons. Per row: visibility, duplicate,
 * delete; cardinality is enforced by the reducer, which refuses and says why.
 * Logical CSS only (`ps-`, `ms-`, `text-start`), so the tree mirrors in Arabic.
 */
import { Button } from '@/components/ui/Button';
import { useEffect } from 'react';
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
  onAddSection: (list: SectionList) => void;
}

function label(node: SectionNode, locale: string): string {
  const d = getSectionDefinition(node.type);
  if (!d) return node.type;
  return locale === 'ar' ? d.labelAr : d.labelEn;
}

function Row({
  node,
  index,
  count,
  selection,
  onSelect,
  onFocusCanvas,
  dispatch,
}: {
  node: SectionNode;
  index: number;
  count: number;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  onFocusCanvas?: (s: Selection) => void;
  dispatch: (a: DocumentAction) => void;
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

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-60' : undefined}
      data-testid={`tree-row-${node.id}`}
    >
      <div
        className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm ${
          selected
            ? 'bg-primary/15 text-foreground ring-1 ring-primary'
            : hovered
              ? 'bg-muted'
              : 'hover:bg-muted'
        }`}
      >
        <button
          data-ui="handle"
          type="button"
          className="min-h-6 min-w-6 cursor-grab touch-none rounded px-1 text-muted-foreground hover:text-foreground"
          aria-label={t('drag', { name })}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <button
          type="button"
          className={`min-w-0 flex-1 truncate text-start ${node.hidden ? 'text-muted-foreground line-through' : ''}`}
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
        <span className="flex items-center opacity-70 group-hover:opacity-100">
          <IconButton
            label={t('moveUp', { name })}
            disabled={index === 0}
            onClick={() => dispatch({ type: 'moveSection', id: node.id, toIndex: index - 1 })}
          >
            ↑
          </IconButton>
          <IconButton
            label={t('moveDown', { name })}
            disabled={index === count - 1}
            onClick={() => dispatch({ type: 'moveSection', id: node.id, toIndex: index + 1 })}
          >
            ↓
          </IconButton>
          {!pinned && (
            <IconButton
              label={node.hidden ? t('show', { name }) : t('hide', { name })}
              onClick={() =>
                dispatch({ type: 'setSectionHidden', id: node.id, hidden: !node.hidden })
              }
            >
              {node.hidden ? '◌' : '◉'}
            </IconButton>
          )}
          {d?.cardinality === 'many' && (
            <IconButton
              label={t('duplicate', { name })}
              onClick={() => dispatch({ type: 'duplicateSection', id: node.id })}
            >
              ⧉
            </IconButton>
          )}
          {pinned ? (
            <span
              role="img"
              aria-label={t('pinned', { name })}
              title={t('pinned', { name })}
              className="px-1.5 py-0.5 text-xs text-muted-foreground"
              data-testid={`tree-pinned-${node.id}`}
            >
              <svg
                viewBox="0 0 16 16"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
                <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
              </svg>
            </span>
          ) : (
            <IconButton
              label={t('remove', { name })}
              onClick={() => dispatch({ type: 'removeSection', id: node.id })}
            >
              ✕
            </IconButton>
          )}
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
                className="flex items-center gap-1"
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
                  className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-start text-xs ${
                    bSelected ? 'bg-primary/15 ring-1 ring-primary' : 'hover:bg-muted'
                  } ${b.hidden ? 'text-muted-foreground line-through' : ''}`}
                >
                  {bName}
                </button>
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
                  ↑
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
                  {b.hidden ? '◌' : '◉'}
                </IconButton>
                <IconButton
                  label={t('remove', { name: bName })}
                  onClick={() =>
                    dispatch({ type: 'removeBlock', sectionId: node.id, blockId: b.id })
                  }
                >
                  ✕
                </IconButton>
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
      {children}
    </Button>
  );
}

function Group({
  list,
  title,
  nodes,
  ...rest
}: Omit<Props, 'doc'> & { list: SectionList; title: string; nodes: SectionNode[] }) {
  const t = useT('builder.tree');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const to = nodes.findIndex(n => n.id === e.over!.id);
    if (to >= 0) rest.dispatch({ type: 'moveSection', id: String(e.active.id), toIndex: to });
  };
  return (
    <section aria-label={title} className="mb-4" data-testid={`tree-group-${list}`}>
      <h2 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={nodes.map(n => n.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-0.5">
            {nodes.map((n, i) => (
              <Row key={n.id} node={n} index={i} count={nodes.length} {...rest} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => rest.onAddSection(list)}
        className="mt-1 w-full justify-start"
        data-testid={`add-section-${list}`}
        data-setting-id="builder.add-section"
      >
        {/* sign-ok: button label glyph, not a number */}+ {t('addSection')}
      </Button>
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
