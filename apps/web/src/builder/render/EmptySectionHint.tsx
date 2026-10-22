'use client';

import React from 'react';
import { useLanguage, translations } from '../../contexts/LanguageContext';

/**
 * Editor canvas only (`PageRenderer` passes `editorMode`). A data-driven
 * section with nothing to show renders NOTHING on the public storefront, so
 * the merchant would otherwise see no trace of it in the canvas and could not
 * select it. This dashed placeholder keeps the section visible and selectable
 * in the editor and says what fills it. Never rendered on a public page.
 */
export type EmptySectionKind =
  | 'categories'
  | 'newArrivals'
  | 'bestSellers'
  | 'brandStory'
  | 'blogCarousel'
  | 'trustStrip'
  | 'testimonials'
  | 'shopTheLook';

const HINT_KEY: Record<EmptySectionKind, keyof typeof translations> = {
  categories: 'Add categories and they will appear here.',
  newArrivals: 'Add products and your newest ones will appear here.',
  bestSellers: 'Best sellers appear here once your products start selling.',
  brandStory: 'Add a store description or image in store settings to show your story here.',
  blogCarousel: 'Publish a blog post to show it here.',
  trustStrip: 'Write your own trust items (delivery, payment, returns) and they will show here.',
  testimonials: 'Customer reviews appear here once customers leave them.',
  shopTheLook: 'Add a look with a photo and its pieces and it will appear here.',
};

export function EmptySectionHint({ kind }: { kind: EmptySectionKind }) {
  const { t } = useLanguage();
  const key = HINT_KEY[kind];
  const note: keyof typeof translations =
    'Only you see this in the editor. Visitors do not see an empty section.';
  return (
    <div
      data-empty-section={kind}
      className="mx-auto my-6 max-w-7xl rounded-[var(--radius)] border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground sm:px-6 lg:px-8"
    >
      <p>{t(key, translations[key])}</p>
      <p className="mt-1 text-xs">{t(note, translations[note])}</p>
    </div>
  );
}
