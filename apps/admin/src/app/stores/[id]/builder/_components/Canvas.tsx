'use client';

/**
 * Center pane: the REAL storefront in an iframe, rendering the unsaved
 * document (BUILDER-PREVIEW-1: desktop 1280 / tablet 820 / mobile 390, scaled
 * to fit the pane). Talks `ebda-builder:v1`: a message is accepted only from
 * the storefront origin we framed AND from that iframe's window, and only
 * when it parses; we post only to that origin.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createFrameCoalescer, type FrameCoalescer } from '../_lib/frame-coalescer';
import {
  BUILDER_PROTOCOL,
  VIEWPORT_RANGES,
  acceptMessage,
  childToParentSchema,
  originOf,
  type ChildToParent,
  type PageDefinition,
  type ParentToChild,
  type Viewport,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';

interface Props {
  storefrontUrl: string;
  /** The storefront path this page renders on (`/` home, `/cart`, `/products`, `/products/<slug>`). */
  path?: string;
  token: string;
  doc: PageDefinition;
  viewport: Viewport;
  selectedId: string | null;
  selectedBlockId?: string | null;
  /** Bumps when saved data changed (new carousel, product source): reload the canvas. */
  reloadKey: number;
  /** Move keyboard focus onto this target on the canvas; a new `n` is a new request. */
  focusRequest?: { sectionId: string; blockId?: string; n: number } | null;
  onMessage: (msg: ChildToParent) => void;
}

export function Canvas({
  storefrontUrl,
  path = '/',
  token,
  doc,
  viewport,
  selectedId,
  selectedBlockId,
  reloadKey,
  focusRequest,
  onMessage,
}: Props) {
  const t = useT('builder.canvas');
  const frame = useRef<HTMLIFrameElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(1);
  const origin = originOf(storefrontUrl);
  const width = VIEWPORT_RANGES[viewport].previewPx;
  const src = `${storefrontUrl.replace(/\/$/, '')}${path}?_preview=${reloadKey}&_builder=${encodeURIComponent(token)}`;

  const post = useCallback(
    (msg: Omit<ParentToChild, 'protocol'>) => {
      const win = frame.current?.contentWindow;
      if (win && origin) win.postMessage({ protocol: BUILDER_PROTOCOL, ...msg }, origin);
    },
    [origin]
  );

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = acceptMessage(
        event,
        origin,
        frame.current?.contentWindow ?? null,
        childToParentSchema
      );
      if (!msg) return;
      if (msg.type === 'ready') setReady(true);
      onMessage(msg);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [origin, onMessage]);

  // Every document change re-renders the canvas without a reload. The post is a structured clone of
  // the whole document, so a burst of edits inside one frame is ONE post of the latest document.
  const renderPost = useRef<FrameCoalescer<PageDefinition> | null>(null);
  useEffect(() => {
    const c = createFrameCoalescer<PageDefinition>(definition =>
      post({ type: 'render', definition } as Omit<ParentToChild, 'protocol'>)
    );
    renderPost.current = c;
    return () => {
      c.cancel();
      renderPost.current = null;
    };
  }, [post]);
  useEffect(() => {
    if (ready) renderPost.current?.schedule(doc);
  }, [ready, doc]);

  // Keyboard path: Enter on a tree row hands focus to the section's first target on the canvas.
  const focusN = focusRequest?.n;
  useEffect(() => {
    if (!ready || !focusRequest) return;
    frame.current?.focus();
    post({
      type: 'focus',
      sectionId: focusRequest.sectionId,
      ...(focusRequest.blockId ? { blockId: focusRequest.blockId } : {}),
    } as Omit<ParentToChild, 'protocol'>);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new request number is the trigger
  }, [ready, focusN, post]);

  useEffect(() => {
    if (ready)
      post({
        type: 'select',
        sectionId: selectedId,
        ...(selectedBlockId ? { blockId: selectedBlockId } : {}),
      } as Omit<ParentToChild, 'protocol'>);
  }, [ready, selectedId, selectedBlockId, post]);

  useEffect(() => setReady(false), [src]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, (el.clientWidth - 32) / width));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  return (
    <div
      ref={wrap}
      // A scrollable region must be keyboard-reachable (axe scrollable-region-focusable): the
      // phone header is two rows tall, so the preview can be taller than the pane.
      id="builder-canvas-region"
      tabIndex={0}
      role="region"
      aria-label={t('title')}
      className="relative flex h-full w-full justify-center overflow-auto bg-muted/40 p-4 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <div
        style={{ width, transform: `scale(${scale})`, transformOrigin: 'top center' }}
        className="shrink-0"
      >
        <iframe
          ref={frame}
          key={src}
          src={src}
          title={t('title')}
          data-testid="builder-canvas"
          data-viewport={viewport}
          style={{ width, height: `calc((100vh - 7rem) / ${scale})` }}
          className="rounded-md border border-border bg-white shadow-2xl"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </div>
      {!ready && (
        <p
          role="status"
          className="pointer-events-none absolute inset-x-0 top-6 text-center text-xs text-muted-foreground"
        >
          {t('loading')}
        </p>
      )}
    </div>
  );
}
