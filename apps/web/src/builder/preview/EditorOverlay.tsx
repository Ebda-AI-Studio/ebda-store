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
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BUILDER_PROTOCOL,
  acceptMessage,
  parentToChildSchema,
  type ChildToParent,
  type PageDefinition,
  type TextTarget,
} from '@ebda/shared';
import { BRAND } from '@ebda/shared';
import { startInlineEdit } from './inline-edit';
import {
  inlineTargetFor,
  labelFor,
  targetOf,
  unionRect,
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
  const [hovered, setHovered] = useState<CanvasTarget | null>(null);
  const [, setTick] = useState(0);

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
    /** Start editing `el` as the text field `field` of `hit`. */
    const edit = (
      el: HTMLElement,
      hit: CanvasTarget,
      field: TextTarget,
      point?: { x: number; y: number }
    ) => {
      const editable = (el.closest('[data-builder-setting]') as HTMLElement | null) ?? el;
      editingRef.current?.cancel();
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
    const onDblClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || el.closest('[contenteditable]:not([contenteditable="false"])')) return;
      const hit = targetOf(el, docRef.current);
      const field = hit && inlineTargetFor(el, docRef.current, hit, localeRef.current);
      if (hit && field) edit(el, hit, field, { x: e.clientX, y: e.clientY });
    };
    const onSubmit = (e: Event) => e.preventDefault();
    const reflow = () => setTick(t => t + 1);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mouseover', onOver);
    document.addEventListener('dblclick', onDblClick);
    document.addEventListener('submit', onSubmit, true);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, { passive: true });
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('dblclick', onDblClick);
      document.removeEventListener('submit', onSubmit, true);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow);
    };
  }, [post]);

  const isRtl = locale === 'ar';
  const outline = (target: CanvasTarget | null, kind: 'hover' | 'selected') => {
    if (!target) return null;
    const box = boxOf(target, docRef.current);
    if (!box) return null;
    const label = labelFor(docRef.current, target, locale);
    const pageWidth = document.documentElement.clientWidth;
    // The chip sits on the box's inline-start edge, above it (inside it at the page top).
    const chipTop = box.top >= 24 ? box.top - 24 : box.top;
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
            outline: `2px ${kind === 'selected' ? 'solid' : 'dashed'} ${BRAND.colors.gold}`,
            outlineOffset: -2,
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
              padding: '2px 8px',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: '20px',
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

  return (
    <>
      {!same(hovered, selected) && outline(hovered, 'hover')}
      {outline(selected, 'selected')}
    </>
  );
}
