'use client';

/**
 * Center pane: the REAL storefront in an iframe, rendering the unsaved
 * document (BUILDER-PREVIEW-1: desktop 1280 / tablet 820 / mobile 390, scaled
 * to fit the pane). Talks `ebda-builder:v1`: a message is accepted only from
 * the storefront origin we framed AND from that iframe's window, and only
 * when it parses; we post only to that origin.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  token: string;
  doc: PageDefinition;
  viewport: Viewport;
  selectedId: string | null;
  selectedBlockId?: string | null;
  /** Bumps when saved data changed (new carousel, product source): reload the canvas. */
  reloadKey: number;
  onMessage: (msg: ChildToParent) => void;
}

export function Canvas({
  storefrontUrl,
  token,
  doc,
  viewport,
  selectedId,
  selectedBlockId,
  reloadKey,
  onMessage,
}: Props) {
  const t = useT('builder.canvas');
  const frame = useRef<HTMLIFrameElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(1);
  const origin = originOf(storefrontUrl);
  const width = VIEWPORT_RANGES[viewport].previewPx;
  const src = `${storefrontUrl.replace(/\/$/, '')}/?_preview=${reloadKey}&_builder=${encodeURIComponent(token)}`;

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

  // Every document change re-renders the canvas without a reload.
  useEffect(() => {
    if (ready) post({ type: 'render', definition: doc } as Omit<ParentToChild, 'protocol'>);
  }, [ready, doc, post]);

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
      className="relative flex h-full w-full justify-center overflow-auto bg-muted/40 p-4"
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
          className="rounded-xl border border-border bg-white shadow-2xl"
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
