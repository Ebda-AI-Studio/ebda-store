'use client';

/**
 * Product, collection and cart pages as section documents (Ruling VE-3 amended, VE-12).
 *
 * The page's client component keeps rendering its pinned MAIN block exactly as it always did; this
 * module only decides which other sections go ABOVE it, which BELOW it, and in what order, from the
 * store's document. With no provider (a page fetched no document) or the default document, the result
 * is the order the page rendered before page documents existed, and the markup is identical:
 * `PageMark` and the section wrappers are transparent outside the editor canvas.
 *
 * Editor canvas only (`editorMode`): each section is wrapped in a `display: contents` marker carrying its
 * id so the overlay can select it, and a section with nothing to show gets a dashed placeholder so it
 * stays selectable. The overlay is mounted here, by the provider, so the public bundle never loads it.
 */
import React, { createContext, useContext, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  defaultPageDocument,
  getSectionDefinition,
  MAIN_SECTION_TYPE,
  PAGE_OWNED_SETTING_KEYS,
  sectionToLegacy,
  type PageDefinition,
  type SectionNode,
  type SectionPageKind,
} from '@ebda/shared';
import { SectionErrorBoundary } from '../../components';
import { useLanguage } from '../../contexts/LanguageContext';
import { ImageTextSection, type ImageTextSettings } from '../sections/ImageTextSection';
import { NewsletterSection, type NewsletterSettings } from '../sections/NewsletterSection';
import { TrustBadgesSection, type TrustBadgesSettings } from '../sections/TrustBadgesSection';
import { MakerProfileSection, type MakerProfileSettings } from '../sections/MakerProfileSection';

const EditorOverlay = dynamic(() => import('../preview/EditorOverlay'), { ssr: false });

export interface PageDocumentValue {
  kind: SectionPageKind;
  definition: PageDefinition;
  editorMode: boolean;
}
const Ctx = createContext<PageDocumentValue | null>(null);

export function PageDocumentProvider({
  kind,
  initialDefinition,
  editorMode = false,
  allowedOrigins = [],
  children,
}: {
  kind: SectionPageKind;
  initialDefinition: PageDefinition;
  editorMode?: boolean;
  allowedOrigins?: string[];
  children: React.ReactNode;
}) {
  const [definition, setDefinition] = useState(initialDefinition);
  const { language } = useLanguage();
  const value = useMemo(() => ({ kind, definition, editorMode }), [kind, definition, editorMode]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {editorMode && (
        <EditorOverlay
          allowedOrigins={allowedOrigins}
          locale={language === 'ar' ? 'ar' : 'en'}
          definition={definition}
          onRender={setDefinition}
        />
      )}
    </Ctx.Provider>
  );
}

/** The page's document: the provider's, else today's default order. */
export function usePageDocument(kind: SectionPageKind): PageDocumentValue {
  const ctx = useContext(Ctx);
  const fallback = useMemo<PageDocumentValue>(
    () => ({ kind, definition: defaultPageDocument(kind), editorMode: false }),
    [kind]
  );
  return ctx && ctx.kind === kind ? ctx : fallback;
}

/**
 * The page's own settings (`siteSettings`, Task 8e) over a layout. In the editor canvas they come from the
 * draft document so a change shows at once; a public render reads the live layout it was given.
 */
export function withPageSettings<L extends object | null | undefined>(
  page: PageDocumentValue,
  layout: L
): L {
  if (!page.editorMode) return layout;
  const next = { ...(layout ?? {}) } as Record<string, unknown>;
  for (const k of PAGE_OWNED_SETTING_KEYS[page.kind]) {
    const v = page.definition.siteSettings[k];
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as L;
}

/** Marks the pinned main block for the editor; transparent everywhere else. */
export function PageMark({ kind, children }: { kind: SectionPageKind; children: React.ReactNode }) {
  const { definition, editorMode } = usePageDocument(kind);
  if (!editorMode) return <>{children}</>;
  const main = definition.sections.find(s => s.type === MAIN_SECTION_TYPE[kind]);
  return (
    <div data-builder-id={main?.id ?? MAIN_SECTION_TYPE[kind]} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

function EmptyHint({ label }: { label: string }) {
  const { t } = useLanguage();
  return (
    <div
      data-empty-section={label}
      className="my-6 rounded-[var(--radius)] border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
    >
      <p>{t('Nothing to show here yet.', 'مفيش حاجة تتعرض هنا لسه.')}</p>
      <p className="mt-1 text-xs">
        {t(
          'Only you see this in the editor. Visitors do not see an empty section.',
          'إنت بس اللي بتشوف ده في المحرر. الزوّار مبيشوفوش القسم الفاضي.'
        )}
      </p>
    </div>
  );
}

/** A section that lives on several pages renders straight from its document node. */
function sharedSection(section: SectionNode, editorMode: boolean): React.ReactNode {
  const settings = sectionToLegacy(section, '') as Record<string, unknown>;
  switch (section.type) {
    case 'image-text':
      return <ImageTextSection settings={settings as ImageTextSettings} editorMode={editorMode} />;
    case 'newsletter':
      return (
        <NewsletterSection settings={settings as NewsletterSettings} editorMode={editorMode} />
      );
    case 'trust-badges':
      return (
        <TrustBadgesSection
          settings={settings as TrustBadgesSettings}
          blocks={section.blocks ?? []}
          editorMode={editorMode}
        />
      );
    case 'maker-profile':
      return (
        <MakerProfileSection settings={settings as MakerProfileSettings} editorMode={editorMode} />
      );
    default:
      return null;
  }
}

/**
 * (Call `usePageDocument` before any early return, this part after: it is a plain function.)
 * The sections around the pinned main block, in document order. `slots` maps a page-kind section type
 * (`product-faq`, `cart-recommendations`, ...) to the node the page already renders for it; a slot that
 * is `null`/`false` means "nothing to show" (no FAQs, a feature switched off), which renders nothing on a
 * public page and a placeholder in the editor.
 */
export interface PageSectionItem {
  id: string;
  type: string;
  node: React.ReactNode;
}

export function pageSectionsAround(
  page: PageDocumentValue,
  slots: Record<string, React.ReactNode>
): { before: PageSectionItem[]; after: PageSectionItem[] } {
  const { kind, definition, editorMode } = page;
  const mainType = MAIN_SECTION_TYPE[kind];
  const before: PageSectionItem[] = [];
  const after: PageSectionItem[] = [];
  const mainAt = definition.sections.findIndex(s => s.type === mainType);
  definition.sections.forEach((section, i) => {
    if (section.type === mainType || section.hidden === true) return;
    const def = getSectionDefinition(section.type);
    if (!def || def.group !== 'template' || !def.pages.includes(kind)) return;
    const isShared = def.pages.length > 1;
    const content = isShared ? sharedSection(section, editorMode) : (slots[section.type] ?? null);
    const present = content !== null && content !== false && content !== undefined;
    if (!present && !editorMode) return;
    const node = isShared ? (
      <SectionErrorBoundary section={section.id}>{content}</SectionErrorBoundary>
    ) : present ? (
      content
    ) : (
      <EmptyHint label={section.type} />
    );
    const marked = editorMode ? (
      <div key={section.id} data-builder-id={section.id} style={{ display: 'contents' }}>
        {node}
      </div>
    ) : (
      <React.Fragment key={section.id}>{node}</React.Fragment>
    );
    (mainAt >= 0 && i < mainAt ? before : after).push({
      id: section.id,
      type: section.type,
      node: marked,
    });
  });
  return { before, after };
}

/** The nodes of a list of items, in order. */
export const itemNodes = (items: PageSectionItem[]): React.ReactNode[] => items.map(i => i.node);
