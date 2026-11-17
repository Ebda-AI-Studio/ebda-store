'use client';

/**
 * The storefront side of the builder canvas (visual builder Phase 2).
 * Loaded with `dynamic(..., { ssr: false })` ONLY by the token-gated preview
 * render (`BuilderPreviewShell`), so it never reaches a public page.
 *
 * - talks `ebda-builder:v1` to the admin editor; every inbound message must
 *   come from an allowed admin origin (the storefront's frame-ancestors) AND
 *   from `window.parent`, and parse against the protocol schema;
 * - click selects the block, section, header, announcement bar or footer
 *   under the pointer (links do not navigate inside the canvas);
 * - hover outlines carry a name chip; the selection keeps a solid gold outline;
 * - double-click on a merchant text setting edits it in place; Enter or
 *   blur commits a `patch-text`, Escape cancels.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ADMIN_TARGETS,
  BUILDER_PROTOCOL,
  acceptMessage,
  parentToChildSchema,
  type ChildToParent,
  type PageDefinition,
  type SectionOp,
  type TextTarget,
} from '@ebda/shared';
import { BRAND } from '@ebda/shared';
import { startInlineEdit } from './inline-edit';
import { installEditorInert } from './editor-inert';
import { cycleIndex, cycleTargets, focusTarget } from './keyboard-logic';
import { CanvasToolbar } from './CanvasToolbar';
import { OVERLAY_SCALE } from './overlay-scale';
import { InsertLine, InsertLineStyles } from './InsertLine';
import {
  dropTargetFor,
  inlineTargetFor,
  insertionGaps,
  labelFor,
  targetOf,
  toolbarStateFor,
  unionRect,
  type DropTarget,
  type SlotBox,
  type CanvasTarget,
  type Rect,
} from './overlay-logic';

interface Props {
  allowedOrigins: string[];
  locale: 'en' | 'ar';
  definition: PageDefinition;
  onRender: (definition: PageDefinition) => void;
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return {
    top: r.top + window.scrollY,
    left: r.left + window.scrollX,
    width: r.width,
    height: r.height,
  };
};

/** The page box of a target: a `display: contents` marker is boxed by its children. */
function boxOf(target: CanvasTarget, doc: PageDefinition): Rect | null {
  const sel = (id: string) => `[data-builder-id="${CSS.escape(id)}"]`;
  if (target.blockId) {
    const els = document.querySelectorAll(
      `${sel(target.sectionId)} [data-builder-block="${CSS.escape(target.blockId)}"]`
    );
    return unionRect(Array.from(els).map(rectOf));
  }
  const marked = document.querySelector(sel(target.sectionId));
  if (marked) return unionRect(Array.from(marked.children).map(rectOf));
  // Header, announcement bar and footer are found by their storefront zone.
  const node = [...doc.sectionGroups.header, ...doc.sectionGroups.footer].find(
    n => n.id === target.sectionId
  );
  const zone =
    node?.type === 'header'
      ? 'header'
      : node?.type === 'announcement'
        ? 'beforeHeader'
        : node?.type === 'footer'
          ? 'footer'
          : null;
  const el = zone ? document.querySelector(`[data-zone="${zone}"]`) : null;
  return el ? unionRect([rectOf(el)]) : null;
}

/** The visible template sections, in document order, with their page boxes. */
function slotsOf(doc: PageDefinition): SlotBox[] {
  const out: SlotBox[] = [];
  doc.sections.forEach((n, index) => {
    if (n.hidden === true) return;
    const box = boxOf({ sectionId: n.id }, doc);
    if (box) out.push({ id: n.id, index, top: box.top, bottom: box.top + box.height });
  });
  return out;
}

interface DragState {
  id: string;
  /** Page y where the drag started, and where the pointer is now. */
  startY: number;
  y: number;
  box: Rect;
  drop: DropTarget | null;
}

interface ImageHandle {
  key: string;
  sectionId: string;
  blockId?: string;
  box: Rect;
}

/**
 * The pictures of the selected target that can be replaced: marked
 * `data-builder-image`, inside the selected block, or (for a section) outside
 * every block. Hidden ones (no box) are skipped.
 */
function imagesOf(target: CanvasTarget | null): ImageHandle[] {
  if (!target) return [];
  const section = document.querySelector(`[data-builder-id="${CSS.escape(target.sectionId)}"]`);
  if (!section) return [];
  const found = new Set<Element>();
  if (target.blockId) {
    for (const root of section.querySelectorAll(
      `[data-builder-block="${CSS.escape(target.blockId)}"]`
    )) {
      if (root.hasAttribute('data-builder-image')) found.add(root);
      for (const el of root.querySelectorAll('[data-builder-image]')) found.add(el);
    }
  } else {
    for (const el of section.querySelectorAll('[data-builder-image]'))
      if (!el.closest('[data-builder-block]')) found.add(el);
  }
  const out: ImageHandle[] = [];
  for (const el of found) {
    const key = el.getAttribute('data-builder-image');
    const box = rectOf(el);
    if (key && box.width > 0 && box.height > 0)
      out.push({ key, sectionId: target.sectionId, blockId: target.blockId, box });
  }
  return out;
}

/** Where the name chip goes: 24px above the box, or just under it when there is no room above. */
export function chipTopFor(box: { top: number; height: number }): number {
  return box.top >= OVERLAY_SCALE.chip ? box.top - OVERLAY_SCALE.chip : box.top + box.height + 4;
}

const COPY = {
  en: { changeImage: 'Change image' },
  ar: { changeImage: 'تغيير الصورة' },
} as const;

const same = (a: CanvasTarget | null, b: CanvasTarget | null) =>
  a?.sectionId === b?.sectionId && a?.blockId === b?.blockId;

export default function EditorOverlay({ allowedOrigins, locale, definition, onRender }: Props) {
  const parentOrigin = useRef<string | null>(null);
  const docRef = useRef(definition);
  docRef.current = definition;
  const [selected, setSelected] = useState<CanvasTarget | null>(null);
  const selectedRef = useRef<CanvasTarget | null>(null);
  selectedRef.current = selected;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const editingRef = useRef<{ cancel: () => void } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  // The insertion index of the gap the pointer is near (reveals its "+"), or null.
  const [nearGap, setNearGap] = useState<number | null>(null);
  const [hovered, setHovered] = useState<CanvasTarget | null>(null);
  const [, setTick] = useState(0);
  // A parent `focus` request: land focus on the first target once the selection has painted.
  const focusAfter = useRef(false);
  // Boxes are read from the DOM: measure again once the new document has painted.
  useLayoutEffect(() => setTick(t => t + 1), [definition]);

  const post = useCallback(
    (msg: Omit<ChildToParent, 'protocol'>) => {
      const full = { protocol: BUILDER_PROTOCOL, ...msg };
      if (parentOrigin.current) window.parent.postMessage(full, parentOrigin.current);
      // Before the first valid parent message we do not know which allowed
      // origin is ours: a postMessage to a non-matching targetOrigin is
      // dropped by the browser, so announcing to each is safe.
      else for (const o of allowedOrigins) window.parent.postMessage(full, o);
    },
    [allowedOrigins]
  );

  useEffect(() => {
    if (window.parent === window) return; // not framed: nothing to talk to
    const onMessage = (event: MessageEvent) => {
      if (!allowedOrigins.includes(event.origin)) return;
      const msg = acceptMessage(event, event.origin, window.parent, parentToChildSchema);
      if (!msg) return;
      parentOrigin.current = event.origin;
      if (msg.type === 'render') onRender(msg.definition);
      if (msg.type === 'focus') {
        const next = { sectionId: msg.sectionId, ...(msg.blockId ? { blockId: msg.blockId } : {}) };
        setSelected(prev => (same(prev, next) ? prev : next));
        selectedRef.current = next;
        focusAfter.current = true;
        setTick(t => t + 1);
      }
      if (msg.type === 'select') {
        const next = msg.sectionId
          ? { sectionId: msg.sectionId, ...(msg.blockId ? { blockId: msg.blockId } : {}) }
          : null;
        setSelected(prev => (same(prev, next) ? prev : next));
        if (next) {
          const box = boxOf(next, docRef.current);
          const view = { top: window.scrollY, bottom: window.scrollY + window.innerHeight };
          // Only scroll when the target is off screen (a click on it already is on screen).
          if (box && (box.top + 40 < view.top || box.top > view.bottom - 40))
            window.scrollTo({ top: Math.max(0, box.top - 80), behavior: 'smooth' });
        }
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' } as Omit<ChildToParent, 'protocol'>);
    return () => window.removeEventListener('message', onMessage);
  }, [allowedOrigins, onRender, post]);

  useEffect(() => {
    if (!focusAfter.current || !selected) return;
    const first = cycleTargets(selected)[0];
    if (!first) return;
    focusAfter.current = false;
    focusTarget(first);
  });

  useEffect(() => {
    /** Start editing `el` as the text field `field` of `hit`. */
    const edit = (
      el: HTMLElement,
      hit: CanvasTarget,
      field: TextTarget,
      point?: { x: number; y: number }
    ) => {
      const editable = (el.closest('[data-builder-setting]') as HTMLElement | null) ?? el;
      editingRef.current?.cancel();
      setIsEditing(true);
      editingRef.current = startInlineEdit({
        editable,
        field,
        point,
        caretColor: BRAND.colors.gold,
        onCommit: value =>
          post({
            type: 'patch-text',
            sectionId: hit.sectionId,
            ...(hit.blockId ? { blockId: hit.blockId } : {}),
            key: field.key,
            value,
          } as Omit<ChildToParent, 'protocol'>),
        onMove: direction => {
          const next = nextTextTarget(editable, direction);
          if (!next) return;
          setSelected(next.hit);
          post({ type: 'select', ...next.hit } as Omit<ChildToParent, 'protocol'>);
          edit(next.el, next.hit, next.field);
        },
        onDone: () => {
          editingRef.current = null;
          setIsEditing(false);
        },
      });
    };
    /** The next (or previous) editable text on the page, in document order. */
    const nextTextTarget = (from: HTMLElement, direction: 1 | -1) => {
      const all = Array.from(document.querySelectorAll<HTMLElement>('[data-builder-setting]'));
      const start = all.indexOf(from);
      for (let i = start + direction; i >= 0 && i < all.length; i += direction) {
        const el = all[i];
        const hit = targetOf(el, docRef.current);
        const field = hit && inlineTargetFor(el, docRef.current, hit, localeRef.current);
        if (hit && field) return { el, hit, field };
      }
      return null;
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[contenteditable]:not([contenteditable="false"])')) return;
      // A hint's "add products" link asks the admin to open that page; the canvas never navigates.
      const action = target?.closest<HTMLElement>('[data-builder-action="open-admin"]');
      if (action) {
        e.preventDefault();
        const to = action.getAttribute('data-builder-target');
        if ((ADMIN_TARGETS as readonly string[]).includes(to ?? ''))
          post({ type: 'open-admin', target: to } as Omit<ChildToParent, 'protocol'>);
        return;
      }
      const hit = targetOf(target, docRef.current);
      // Inside the canvas a click selects; it never navigates or submits.
      if (target?.closest('a, button, form')) e.preventDefault();
      if (!hit || !target) return;
      // A click on text inside the target that is ALREADY selected edits it (Shopify's
      // behaviour); the first click only selects.
      const cur = selectedRef.current;
      const alreadyThere =
        cur?.sectionId === hit.sectionId && (!cur.blockId || cur.blockId === hit.blockId);
      const field = alreadyThere
        ? inlineTargetFor(target, docRef.current, hit, localeRef.current)
        : null;
      if (field) {
        e.preventDefault();
        edit(target, hit, field, { x: e.clientX, y: e.clientY });
        return;
      }
      setSelected(hit);
      post({ type: 'select', ...hit } as Omit<ChildToParent, 'protocol'>);
    };
    const onOver = (e: MouseEvent) => {
      const hit = targetOf(e.target as Element | null, docRef.current);
      setHovered(prev => {
        if (same(prev, hit)) return prev;
        post({
          type: 'hover',
          sectionId: hit?.sectionId ?? null,
          ...(hit?.blockId ? { blockId: hit.blockId } : {}),
        } as Omit<ChildToParent, 'protocol'>);
        return hit;
      });
    };
    let nearRaf = 0;
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) return;
      cancelAnimationFrame(nearRaf);
      nearRaf = requestAnimationFrame(() => {
        const gaps = insertionGaps(slotsOf(docRef.current));
        let hit: number | null = null;
        let best = 18;
        for (const g of gaps) {
          const d = Math.abs(g.y - e.pageY);
          if (d <= best) {
            best = d;
            hit = g.index;
          }
        }
        setNearGap(prev => (prev === hit ? prev : hit));
      });
    };
    const onDblClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || el.closest('[contenteditable]:not([contenteditable="false"])')) return;
      const hit = targetOf(el, docRef.current);
      const field = hit && inlineTargetFor(el, docRef.current, hit, localeRef.current);
      if (hit && field) edit(el, hit, field, { x: e.clientX, y: e.clientY });
    };
    const onSubmit = (e: Event) => e.preventDefault();
    // Keyboard path: Tab cycles the selected target, Enter edits the focused text, Esc goes back to
    // the tree, Alt+Arrow moves the selection. Typing in a text being edited is left alone.
    const onKeyDown = (e: KeyboardEvent) => {
      const sel = selectedRef.current;
      if (!sel || editingRef.current || dragRef.current) return;
      const active = document.activeElement as HTMLElement | null;
      // IME composition and the page's own form fields (a newsletter input in editor mode) keep
      // their native Tab / Esc / Alt+Arrow; only the editable-target markers join the cycle.
      if (e.isComposing) return;
      if (
        active &&
        !active.hasAttribute('data-builder-setting') &&
        active.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      )
        return;
      if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const list = cycleTargets(sel);
        if (list.length === 0) return;
        e.preventDefault();
        const at = active ? list.indexOf(active) : -1;
        const to = list[cycleIndex(list.length, at, e.shiftKey)];
        if (to) focusTarget(to);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        post({ type: 'focus-tree' } as Omit<ChildToParent, 'protocol'>);
        return;
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const op = e.key === 'ArrowUp' ? 'moveUp' : 'moveDown';
        const state = toolbarStateFor(docRef.current, sel);
        if (!state) return;
        e.preventDefault();
        if (state.disabled[op]) return;
        post({
          type: 'section-op',
          sectionId: sel.sectionId,
          ...(sel.blockId ? { blockId: sel.blockId } : {}),
          op,
        } as Omit<ChildToParent, 'protocol'>);
        return;
      }
      if (e.key === 'Enter' && !e.altKey && active?.hasAttribute('data-builder-setting')) {
        const hit = targetOf(active, docRef.current);
        const field = hit && inlineTargetFor(active, docRef.current, hit, localeRef.current);
        if (hit && field) {
          e.preventDefault();
          e.stopPropagation(); // the editor that just opened must not see this Enter and commit
          edit(active, hit, field);
        }
      }
    };
    // Capture: runs before the inline editor's own handler, so Esc while editing is still "editing".
    document.addEventListener('keydown', onKeyDown, true);
    const reflow = () => setTick(t => t + 1);
    // BEFORE the click handler below (same node): it decides what is exempt (text about to be
    // edited) from the DOM as the tap found it, and stopping propagation does not stop that handler.
    const uninstallInert = installEditorInert();
    document.addEventListener('click', onClick, true);
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('dblclick', onDblClick);
    document.addEventListener('submit', onSubmit, true);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reflow);
    ro?.observe(document.body);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, { passive: true });
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(nearRaf);
      document.removeEventListener('dblclick', onDblClick);
      document.removeEventListener('submit', onSubmit, true);
      document.removeEventListener('keydown', onKeyDown, true);
      uninstallInert();
      ro?.disconnect();
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow);
    };
  }, [post]);

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    let scrollRaf = 0;
    const edgeScroll = (clientY: number) => {
      cancelAnimationFrame(scrollRaf);
      const edge = 70;
      const dy = clientY < edge ? -14 : clientY > window.innerHeight - edge ? 14 : 0;
      if (dy) {
        window.scrollBy(0, dy);
        scrollRaf = requestAnimationFrame(() => edgeScroll(clientY));
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const y = e.clientY + window.scrollY;
      setDrag({ ...cur, y, drop: dropTargetFor(slotsOf(docRef.current), cur.id, y) });
      edgeScroll(e.clientY);
    };
    const finish = (commit: boolean) => {
      const cur = dragRef.current;
      setDrag(null);
      if (commit && cur?.drop && !cur.drop.noop)
        post({
          type: 'move',
          sectionId: cur.id,
          toIndex: cur.drop.toIndex,
        } as Omit<ChildToParent, 'protocol'>);
    };
    const onUp = () => finish(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(scrollRaf);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [dragging, post]);

  const startDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const sel = selectedRef.current;
    if (!sel || sel.blockId || e.button !== 0) return;
    const box = boxOf({ sectionId: sel.sectionId }, docRef.current);
    if (!box) return;
    e.preventDefault();
    const y = e.clientY + window.scrollY;
    setDrag({
      id: sel.sectionId,
      startY: y,
      y,
      box,
      drop: dropTargetFor(slotsOf(docRef.current), sel.sectionId, y),
    });
  };

  const isRtl = locale === 'ar';
  const outline = (target: CanvasTarget | null, kind: 'hover' | 'selected') => {
    if (!target) return null;
    const box = boxOf(target, docRef.current);
    if (!box) return null;
    const label = labelFor(docRef.current, target, locale);
    const pageWidth = document.documentElement.clientWidth;
    // The chip sits on the box's inline-start edge, OUTSIDE it: above, or below at the page top, so
    // it never covers the section's own content (a long store name in the header).
    const chipTop = chipTopFor(box);
    const chipStart = isRtl ? Math.max(0, pageWidth - (box.left + box.width)) : box.left;
    return (
      <>
        <div
          data-builder-outline={kind}
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: box.top,
            insetInlineStart: chipStart,
            width: box.width,
            height: box.height,
            pointerEvents: 'none',
            zIndex: 2147483000,
            outline: `${
              kind === 'selected' ? OVERLAY_SCALE.outlineSelected : OVERLAY_SCALE.outlineHover
            }px solid ${BRAND.colors.gold}`,
            outlineOffset: -(kind === 'selected'
              ? OVERLAY_SCALE.outlineSelected
              : OVERLAY_SCALE.outlineHover),
          }}
        />
        {label && (
          <div
            data-builder-chip={kind}
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: chipTop,
              insetInlineStart: chipStart,
              maxWidth: Math.max(120, box.width),
              pointerEvents: 'none',
              zIndex: 2147483001,
              height: OVERLAY_SCALE.chip,
              padding: '0 8px',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: `${OVERLAY_SCALE.chip}px`,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              background: kind === 'selected' ? BRAND.colors.gold : '#1c1917',
              color: kind === 'selected' ? '#1c1917' : '#ffffff',
              direction: isRtl ? 'rtl' : 'ltr',
            }}
          >
            {label}
          </div>
        )}
      </>
    );
  };

  const pageWidth = document.documentElement.clientWidth;
  const imageButtons = imagesOf(selected).map(h => (
    <button
      key={`${h.blockId ?? ''}/${h.key}/${Math.round(h.box.top)}`}
      type="button"
      data-builder-change-image={h.key}
      aria-label={COPY[locale].changeImage}
      onClick={e => {
        e.stopPropagation();
        post({
          type: 'request-media',
          sectionId: h.sectionId,
          ...(h.blockId ? { blockId: h.blockId } : {}),
          key: h.key,
        } as Omit<ChildToParent, 'protocol'>);
      }}
      style={{
        position: 'absolute',
        top: h.box.top + 8,
        insetInlineEnd: isRtl
          ? h.box.left + 8
          : Math.max(0, pageWidth - (h.box.left + h.box.width)) + 8,
        zIndex: 2147483002,
        minHeight: 36,
        padding: '0 12px',
        borderRadius: 8,
        border: `1px solid ${BRAND.colors.gold}`,
        background: '#1c1917',
        color: '#ffffff',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        direction: isRtl ? 'rtl' : 'ltr',
      }}
    >
      {COPY[locale].changeImage}
    </button>
  ));

  // Toolbar on the selected template section / block (hidden while dragging or typing).
  const toolbarState = selected ? toolbarStateFor(docRef.current, selected) : null;
  const toolbarBox = selected && toolbarState && !drag ? boxOf(selected, docRef.current) : null;
  const gaps = drag ? [] : insertionGaps(slotsOf(docRef.current));

  return (
    <>
      <InsertLineStyles />
      <style
        data-builder-focus-style
      >{`[data-builder-setting]:focus-visible,[data-builder-toolbar-root] button:focus-visible,[data-builder-change-image]:focus-visible{outline:2px solid ${BRAND.colors.gold};outline-offset:2px}`}</style>
      {!drag && !same(hovered, selected) && outline(hovered, 'hover')}
      {outline(selected, 'selected')}
      {imageButtons}
      {selected && toolbarState && toolbarBox && !isEditing && (
        <CanvasToolbar
          locale={locale}
          box={toolbarBox}
          pageWidth={pageWidth}
          draggable={toolbarState.draggable}
          disabled={toolbarState.disabled}
          ai={toolbarState.ai}
          labels={window.innerWidth >= 768}
          onDragStart={startDrag}
          onOp={(op: SectionOp) =>
            post({
              type: 'section-op',
              sectionId: selected.sectionId,
              ...(selected.blockId ? { blockId: selected.blockId } : {}),
              op,
            } as Omit<ChildToParent, 'protocol'>)
          }
        />
      )}
      {gaps.map(g => (
        <InsertLine
          key={`gap-${g.index}`}
          locale={locale}
          y={g.y}
          pageWidth={pageWidth}
          on={nearGap === g.index}
          onAdd={() =>
            post({
              type: 'request-add',
              list: 'template',
              index: g.index,
            } as Omit<ChildToParent, 'protocol'>)
          }
        />
      ))}
      {drag && (
        <>
          <div
            aria-hidden="true"
            data-builder-drag-ghost
            style={{
              position: 'absolute',
              top: drag.box.top + (drag.y - drag.startY),
              insetInlineStart: isRtl
                ? Math.max(0, pageWidth - (drag.box.left + drag.box.width))
                : drag.box.left,
              width: drag.box.width,
              height: drag.box.height,
              pointerEvents: 'none',
              zIndex: 2147483004,
              outline: `2px dashed ${BRAND.colors.gold}`,
              outlineOffset: -2,
              background: 'rgba(176,141,87,0.14)',
            }}
          />
          {drag.drop && !drag.drop.noop && (
            <div
              aria-hidden="true"
              data-builder-drop-line
              style={{
                position: 'absolute',
                top: drag.drop.y - 2,
                insetInlineStart: 0,
                width: pageWidth,
                height: 4,
                pointerEvents: 'none',
                zIndex: 2147483004,
                background: BRAND.colors.gold,
              }}
            />
          )}
        </>
      )}
    </>
  );
}
