'use client';

/**
 * The builder canvas page body (visual builder Phase 2): the real storefront
 * homepage renderer, fed the editor's UNSAVED document over postMessage, with
 * the selection/inline-edit overlay on top. Rendered by `HomePageBody` only
 * when the request carries `?_preview` AND a valid builder preview token, so
 * the overlay chunk is never part of a public page.
 */
import { useCallback, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  applyTypographyPatch,
  hasTypographyPatch,
  shareStructure,
  type PageDefinition,
} from '@ebda/shared';
import { emitZoneCss } from '../../lib/emit-zone-css';
import { HomePageContent } from '../../app/HomePageContent';
import { useLanguage } from '../../contexts/LanguageContext';
import { PreviewThemeOverride, useStore } from '../../contexts/StoreContext';

const EditorOverlay = dynamic(() => import('./EditorOverlay'), { ssr: false });

type ContentProps = Omit<React.ComponentProps<typeof HomePageContent>, 'definition' | 'editorMode'>;

export function BuilderPreviewShell({
  initialDefinition,
  allowedOrigins,
  liveTypography,
  ...content
}: ContentProps & {
  initialDefinition: PageDefinition;
  allowedOrigins: string[];
  /** The store's LIVE typography; the draft's pending patch is applied over it (Ruling VE-4). */
  liveTypography?: unknown;
}) {
  const [definition, setDefinition] = useState(initialDefinition);
  // A parsed `render` message has no object identity; keep every unchanged section's old object so
  // the memoized section bodies skip (Task 13).
  const onRender = useCallback(
    (next: PageDefinition) => setDefinition(prev => shareStructure(prev, next)),
    []
  );
  const { language } = useLanguage();
  const { store } = useStore();
  // The draft's fonts + typography zones, repainted on every `render` message. The CSS is built by
  // the one emitter the draft preview already uses and follows the head's committed rules in
  // source order.
  const typographyCss = useMemo(
    () =>
      hasTypographyPatch(definition.typography)
        ? emitZoneCss(
            applyTypographyPatch(liveTypography, definition.typography),
            store.theme as Parameters<typeof emitZoneCss>[1]
          )
        : '',
    [definition.typography, liveTypography, store.theme]
  );
  return (
    // The draft's pending theme edits ride the document, so the canvas paints
    // them as soon as they are saved (and live, via the postMessage render).
    <PreviewThemeOverride theme={definition.theme} chrome={definition.chrome}>
      {typographyCss && (
        <style data-builder-typography dangerouslySetInnerHTML={{ __html: typographyCss }} />
      )}
      <HomePageContent {...content} definition={definition} editorMode />
      <EditorOverlay
        allowedOrigins={allowedOrigins}
        locale={language === 'ar' ? 'ar' : 'en'}
        definition={definition}
        onRender={onRender}
      />
    </PreviewThemeOverride>
  );
}
