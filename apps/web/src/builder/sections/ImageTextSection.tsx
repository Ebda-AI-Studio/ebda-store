'use client';

/**
 * `image-text` (visual builder Phase 2, document-only section): an image
 * beside a heading, text and an optional button. Arabic-first: the image
 * side is LOGICAL (`start` sits on the right in Arabic) and every string has
 * an Arabic twin. Compact sizing per design.md (max-w-7xl, py-12 baseline).
 *
 * `data-builder-setting` marks the editable text so the editor overlay can
 * offer inline editing; it is only present on preview renders.
 */
import React from 'react';
import { sanitizeUrl } from '@force/shared';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import type { SectionPaddingMaxWidthVisibility } from '@force/shared';
import { ResponsiveImg } from '../../components/ResponsiveImg';

export interface ImageTextSettings extends SectionPaddingMaxWidthVisibility {
  image?: string;
  imageAr?: string;
  alt?: string;
  altAr?: string;
  heading?: string;
  headingAr?: string;
  body?: string;
  bodyAr?: string;
  buttonText?: string;
  buttonTextAr?: string;
  buttonLink?: string;
  imagePosition?: 'start' | 'end';
  imageAspect?: 'square' | 'portrait' | 'landscape';
  bgColor?: string;
}

const ASPECT: Record<NonNullable<ImageTextSettings['imageAspect']>, string> = {
  square: 'aspect-square',
  portrait: 'aspect-[4/5]',
  landscape: 'aspect-[4/3]',
};

export function ImageTextSection({
  settings,
  editorMode = false,
}: {
  settings: ImageTextSettings;
  editorMode?: boolean;
}) {
  const { store } = useStore();
  const { language } = useLanguage();
  const storeUrl = useStoreUrl();
  const ar = language === 'ar';
  const pick = (en?: string, arv?: string) => (ar ? arv || en : en || arv) || '';
  const heading = pick(settings.heading, settings.headingAr);
  const body = pick(settings.body, settings.bodyAr);
  const button = pick(settings.buttonText, settings.buttonTextAr);
  const image = pick(settings.image, settings.imageAr);
  const alt = pick(settings.alt, settings.altAr);
  const spacing = sectionSpacingClasses(settings);
  const edit = (key: string) =>
    editorMode ? { 'data-builder-setting': ar ? `${key}Ar` : key } : {};
  const imageFirst = (settings.imagePosition ?? 'start') === 'start';

  return (
    <section
      data-section="image-text"
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div
        className={`${spacing.innerContainerClass} grid items-center gap-6 md:grid-cols-2 md:gap-10`}
      >
        <div className={imageFirst ? 'md:order-1' : 'md:order-2'}>
          {image ? (
            <ResponsiveImg
              src={image}
              sizes="(min-width: 768px) 50vw, 100vw"
              alt={alt}
              loading="lazy"
              className={`w-full rounded-[var(--radius)] object-cover ${ASPECT[settings.imageAspect ?? 'square']}`}
            />
          ) : (
            <div
              aria-hidden="true"
              className={`w-full rounded-[var(--radius)] bg-muted ${ASPECT[settings.imageAspect ?? 'square']}`}
            />
          )}
        </div>
        <div className={`${imageFirst ? 'md:order-2' : 'md:order-1'} text-start`}>
          {heading && (
            <h2
              className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
              {...edit('heading')}
            >
              {heading}
            </h2>
          )}
          {body && (
            <p
              className="mt-3 whitespace-pre-line text-base leading-relaxed text-muted-foreground"
              {...edit('body')}
            >
              {body}
            </p>
          )}
          {button && (
            <a
              href={storeUrl(sanitizeUrl(settings.buttonLink, '/products'))}
              className="mt-5 inline-flex min-h-[44px] items-center rounded-[var(--radius)] bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              {...edit('buttonText')}
            >
              {button}
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
