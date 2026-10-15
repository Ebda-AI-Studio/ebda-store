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
import { sanitizeUrl } from '@ebda/shared';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import type { SectionPaddingMaxWidthVisibility } from '@ebda/shared';

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
  layout?: 'split' | 'full-bleed';
  imagePosition?: 'start' | 'end';
  imageAspect?: 'square' | 'portrait' | 'landscape';
  bgColor?: string;
}

/**
 * The solid scrim behind full-bleed text (Ruling B1-2, amendment C15). Not an edge-only
 * gradient: the whole photo is darkened evenly so the text reads wherever it sits, whatever
 * the photo. Worst case (a pure-white photo) is rgba(0,0,0,.6) over #fff = #666, and white
 * text on that is 5.74:1. Task 4's contrast test imports these.
 */
export const FULL_BLEED_SCRIM = { color: '#000000', opacity: 0.6 } as const;
export const FULL_BLEED_TEXT = '#FFFFFF';

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
  const spacing = sectionSpacingClasses(settings, store.look);
  const edit = (key: string) =>
    editorMode ? { 'data-builder-setting': ar ? `${key}Ar` : key } : {};
  const imageFirst = (settings.imagePosition ?? 'start') === 'start';
  // A section with no image, heading, text or button is an empty shell: hide it
  // on the public storefront. The editor canvas still shows it (with the grey
  // image placeholder) so the merchant can select and fill it.
  const hasContent = !!(image || heading || body || button);
  if (!hasContent && !editorMode) return null;
  // No image chosen yet: publicly show the text on its own, never a grey box.
  const showImageColumn = !!image || editorMode;

  const textColumnClass = showImageColumn
    ? `${imageFirst ? 'md:order-2' : 'md:order-1'} text-start`
    : 'text-start md:col-span-2';

  if ((settings.layout ?? 'split') === 'full-bleed' && image) {
    return (
      <section
        data-section="image-text"
        data-layout="full-bleed"
        className="relative w-full overflow-hidden"
        style={sectionBgStyle(settings.bgColor, store.theme)}
      >
        <img
          src={image}
          alt={alt}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            backgroundColor: FULL_BLEED_SCRIM.color,
            opacity: FULL_BLEED_SCRIM.opacity,
          }}
        />
        <div className="relative flex min-h-[60svh] w-full items-end">
          <div
            className={`${spacing.innerContainerClass} pb-10 text-start`}
            style={{ color: FULL_BLEED_TEXT }}
          >
            {heading && (
              <h2 className="font-display text-3xl sm:text-4xl" {...edit('heading')}>
                {heading}
              </h2>
            )}
            {body && (
              <p className="mt-2 max-w-prose text-base leading-relaxed" {...edit('body')}>
                {body}
              </p>
            )}
            {button && (
              <a
                href={storeUrl(sanitizeUrl(settings.buttonLink, '/products'))}
                className="mt-5 inline-flex min-h-[44px] items-center rounded-[var(--radius)] bg-white px-5 text-sm font-medium text-black"
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

  return (
    <section
      data-section="image-text"
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div
        className={`${spacing.innerContainerClass} grid items-center gap-6 md:grid-cols-2 md:gap-10`}
      >
        {showImageColumn && (
          <div className={imageFirst ? 'md:order-1' : 'md:order-2'}>
            {image ? (
              <img
                src={image}
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
        )}
        <div className={textColumnClass}>
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
