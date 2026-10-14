'use client';

/**
 * The storefront side of the builder canvas (visual builder Phase 2).
 * Loaded with `dynamic(..., { ssr: false })` ONLY by the token-gated preview
 * render (`BuilderPreviewShell`), so it never reaches a public page.
 *
 * - talks `ebda-builder:v1` to the admin editor; every inbound message must
 *   come from an allowed admin origin (the storefront's frame-ancestors) AND
 *   from `window.parent`, and parse against the protocol schema;
 * - click selects a section (links do not navigate inside the canvas);
 * - hover outlines; the selected section keeps a gold outline;
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
} from '@ebda/shared';
import { BRAND } from '@ebda/shared';
import { inlineSettingFor, sectionIdOf, unionRect, type Rect } from './overlay-logic';

interface Props {
  allowedOrigins: string[];
  locale: 'en' | 'ar';
  definition: PageDefinition;
  onRender: (definition: PageDefinition) => void;
}

function boxOf(id: string): Rect | null {
  const el = document.querySelector(`[data-builder-id="${CSS.escape(id)}"]`);
  if (!el) return null;
  const rects = Array.from(el.children).map(c => {
    const r = c.getBoundingClientRect();
    return {
      top: r.top + window.scrollY,
      left: r.left + window.scrollX,
      width: r.width,
      height: r.height,
    };
  });
  return unionRect(rects);
}

export default function EditorOverlay({ allowedOrigins, locale, definition, onRender }: Props) {
  const parentOrigin = useRef<string | null>(null);
  const docRef = useRef(definition);
  docRef.current = definition;
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
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
        setSelected(msg.sectionId);
        if (msg.sectionId) {
          const box = boxOf(msg.sectionId);
          if (box) window.scrollTo({ top: Math.max(0, box.top - 80), behavior: 'smooth' });
        }
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' } as Omit<ChildToParent, 'protocol'>);
    return () => window.removeEventListener('message', onMessage);
  }, [allowedOrigins, onRender, post]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest('[contenteditable="true"]')) return;
      const id = sectionIdOf(target);
      // Inside the canvas a click selects; it never navigates or submits.
      if (target?.closest('a, button, form')) e.preventDefault();
      if (!id) return;
      setSelected(id);
      post({ type: 'select', sectionId: id } as Omit<ChildToParent, 'protocol'>);
    };
    const onOver = (e: MouseEvent) => {
      const id = sectionIdOf(e.target as Element | null);
      setHovered(prev => {
        if (prev !== id) post({ type: 'hover', sectionId: id } as Omit<ChildToParent, 'protocol'>);
        return id;
      });
    };
    const onDblClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      const id = sectionIdOf(el);
      if (!id) return;
      const key = inlineSettingFor(el, docRef.current, id, locale);
      if (!key) return;
      const editable = (el.closest('[data-builder-setting]') as HTMLElement | null) ?? el;
      const before = editable.innerText;
      editable.contentEditable = 'true';
      editable.focus();
      const finish = (commit: boolean) => {
        editable.contentEditable = 'false';
        editable.removeEventListener('blur', onBlur);
        editable.removeEventListener('keydown', onKey);
        const value = editable.innerText.trim().slice(0, 2048);
        if (!commit) editable.innerText = before;
        else if (value !== before.trim())
          post({ type: 'patch-text', sectionId: id, key, value } as Omit<
            ChildToParent,
            'protocol'
          >);
      };
      const onBlur = () => finish(true);
      const onKey = (k: KeyboardEvent) => {
        if (k.key === 'Enter' && !k.shiftKey) {
          k.preventDefault();
          editable.blur();
        }
        if (k.key === 'Escape') {
          finish(false);
        }
      };
      editable.addEventListener('blur', onBlur);
      editable.addEventListener('keydown', onKey);
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
  }, [locale, post]);

  const outline = (id: string | null, kind: 'hover' | 'selected') => {
    if (!id) return null;
    const box = boxOf(id);
    if (!box) return null;
    return (
      <div
        data-builder-outline={kind}
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: box.top,
          left: box.left,
          width: box.width,
          height: box.height,
          pointerEvents: 'none',
          zIndex: 2147483000,
          outline: `2px ${kind === 'selected' ? 'solid' : 'dashed'} ${BRAND.colors.gold}`,
          outlineOffset: -2,
        }}
      />
    );
  };

  return (
    <>
      {hovered !== selected && outline(hovered, 'hover')}
      {outline(selected, 'selected')}
    </>
  );
}
