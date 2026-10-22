'use client';

/**
 * `trust-badges` (builder Phase 3 pilot, document-only): a row of
 * reassurances — cash on delivery, InstaPay, delivery, certified karat —
 * each a `badge` block (icon + title + line). Copy only: the section states
 * what the store offers and links nowhere, so it can never promise a payment
 * method the checkout does not take; merchants edit the words.
 */
import React from 'react';
import type { BlockNode, SectionPaddingMaxWidthVisibility } from '@ebda/shared';
import { useStore } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { BadgeGlyph } from '../../templates/dahab/ui';

export interface TrustBadgesSettings extends SectionPaddingMaxWidthVisibility {
  heading?: string;
  headingAr?: string;
  layout?: 'row' | 'grid';
  bgColor?: string;
}

export function TrustBadgesSection({
  settings,
  blocks,
  editorMode = false,
}: {
  settings: TrustBadgesSettings;
  blocks: BlockNode[];
  editorMode?: boolean;
}) {
  const { store } = useStore();
  const { language } = useLanguage();
  const ar = language === 'ar';
  const pick = (en?: unknown, a?: unknown) =>
    ((ar ? (a as string) || (en as string) : (en as string) || (a as string)) ?? '').trim();
  const spacing = sectionSpacingClasses(settings, store.look);
  const badges = blocks
    .filter(b => b.type === 'badge' && b.hidden !== true)
    .map(b => ({
      id: b.id,
      icon: typeof b.settings.icon === 'string' ? b.settings.icon : undefined,
      title: pick(b.settings.title, b.settings.titleAr),
      text: pick(b.settings.text, b.settings.textAr),
    }))
    .filter(b => b.title || b.text);
  if (badges.length === 0) return null;
  const heading = pick(settings.heading, settings.headingAr);
  const grid = settings.layout === 'grid';

  return (
    <section
      data-section="trust-badges"
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div className={spacing.innerContainerClass}>
        {heading && (
          <h2
            className="font-display mb-8 text-center text-[clamp(1.4rem,1.1rem+1vw,2rem)] text-foreground"
            {...(editorMode ? { 'data-builder-setting': ar ? 'headingAr' : 'heading' } : undefined)}
          >
            {heading}
          </h2>
        )}
        <ul
          className={
            grid
              ? 'grid grid-cols-2 gap-6 md:grid-cols-3'
              : `grid grid-cols-2 gap-x-4 gap-y-7 border-y border-border py-8 sm:gap-x-6 ${badges.length >= 4 ? 'md:grid-cols-4' : 'md:grid-cols-3'}`
          }
        >
          {badges.map(b => (
            <li
              key={b.id}
              {...(editorMode ? { 'data-builder-block': b.id } : undefined)}
              className="flex flex-col items-center gap-3 text-center"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-primary/40 text-primary">
                <BadgeGlyph icon={b.icon} className="h-6 w-6" />
              </span>
              <span>
                {b.title && (
                  <span
                    className="block text-[15px] text-foreground"
                    {...(editorMode
                      ? { 'data-builder-setting': ar ? 'titleAr' : 'title' }
                      : undefined)}
                  >
                    {b.title}
                  </span>
                )}
                {b.text && (
                  <span
                    className="mt-1 block text-[13px] leading-snug text-muted-foreground"
                    {...(editorMode
                      ? { 'data-builder-setting': ar ? 'textAr' : 'text' }
                      : undefined)}
                  >
                    {b.text}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
