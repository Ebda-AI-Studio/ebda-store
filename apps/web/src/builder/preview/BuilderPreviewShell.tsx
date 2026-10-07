'use client';

/**
 * The builder canvas page body (visual builder Phase 2): the real storefront
 * homepage renderer, fed the editor's UNSAVED document over postMessage, with
 * the selection/inline-edit overlay on top. Rendered by `HomePageBody` only
 * when the request carries `?_preview` AND a valid builder preview token, so
 * the overlay chunk is never part of a public page.
 */
import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { PageDefinition } from '@force/shared';
import { HomePageContent } from '../../app/HomePageContent';
import { useLanguage } from '../../contexts/LanguageContext';

const EditorOverlay = dynamic(() => import('./EditorOverlay'), { ssr: false });

type ContentProps = Omit<React.ComponentProps<typeof HomePageContent>, 'definition' | 'editorMode'>;

export function BuilderPreviewShell({
  initialDefinition,
  allowedOrigins,
  ...content
}: ContentProps & { initialDefinition: PageDefinition; allowedOrigins: string[] }) {
  const [definition, setDefinition] = useState(initialDefinition);
  const { language } = useLanguage();
  return (
    <>
      <HomePageContent {...content} definition={definition} editorMode />
      <EditorOverlay
        allowedOrigins={allowedOrigins}
        locale={language === 'ar' ? 'ar' : 'en'}
        definition={definition}
        onRender={setDefinition}
      />
    </>
  );
}
