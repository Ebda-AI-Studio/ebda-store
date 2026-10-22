'use client';

/**
 * `maker-profile` (Phase B4, Lamma; Ruling B1-4 shape): who cooks. `strip` = avatar, name, one
 * line and the hygiene line; `lead` = the photo first and large, a "from the kitchen of ..."
 * heading and a clamped story with a link to the story page when the merchant set one. Text never
 * sits over the photo (taste rule 7). Every field is optional; with neither a name nor a photo the
 * section renders nothing on the public storefront (the editor shows the hint). Bilingual with the
 * active language winning and a non-blank fallback to the other.
 */
import React from 'react';
import type { SectionPaddingMaxWidthVisibility } from '@ebda/shared';
import { sanitizeUrl } from '@ebda/shared';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { EmptySectionHint } from '../render/EmptySectionHint';

export interface MakerProfileSettings extends SectionPaddingMaxWidthVisibility {
  variant?: 'strip' | 'lead';
  image?: string;
  imageAr?: string;
  alt?: string;
  altAr?: string;
  name?: string;
  nameAr?: string;
  role?: string;
  roleAr?: string;
  story?: string;
  storyAr?: string;
  hygiene?: string;
  hygieneAr?: string;
  years?: number;
  storyLink?: string;
  bgColor?: string;
}

export function MakerProfileSection({
  settings,
  editorMode = false,
}: {
  settings: MakerProfileSettings;
  editorMode?: boolean;
}) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const ar = language === 'ar';
  const pick = (en?: string, a?: string) =>
    (ar ? a?.trim() || en?.trim() : en?.trim() || a?.trim()) ?? '';
  const edit = (key: string): Record<string, string> =>
    editorMode ? { 'data-builder-setting': ar ? `${key}Ar` : key } : {};
  const name = pick(settings.name, settings.nameAr);
  const image = pick(settings.image, settings.imageAr);
  if (!name && !image) return editorMode ? <EmptySectionHint kind="makerProfile" /> : null;
  const role = pick(settings.role, settings.roleAr);
  const story = pick(settings.story, settings.storyAr);
  const hygiene = pick(settings.hygiene, settings.hygieneAr);
  const alt = pick(settings.alt, settings.altAr) || name;
  const years =
    typeof settings.years === 'number' && settings.years > 0
      ? t(`Cooking for ${settings.years} years`, `بطبخ من ${settings.years} سنة`)
      : '';
  const spacing = sectionSpacingClasses(settings, store.look);
  const lead = settings.variant === 'lead';
  const link = settings.storyLink ? storeUrl(sanitizeUrl(settings.storyLink, '/about')) : '';

  if (!lead) {
    return (
      <section
        data-section="maker-profile"
        data-variant="strip"
        className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
        style={sectionBgStyle(settings.bgColor, store.theme)}
      >
        <div className={spacing.innerContainerClass}>
          <div className="flex items-center gap-4 rounded-[var(--radius)] bg-card p-4 text-start">
            {image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image}
                alt={alt}
                loading="lazy"
                className="h-16 w-16 shrink-0 rounded-full object-cover"
              />
            )}
            <div className="min-w-0">
              {name && (
                <p className="font-display text-lg font-bold text-foreground" {...edit('name')}>
                  {name}
                </p>
              )}
              {(role || years) && (
                <p className="text-sm text-muted-foreground" {...edit('role')}>
                  {role || years}
                </p>
              )}
              {hygiene && (
                <p className="mt-1 text-sm font-medium text-foreground" {...edit('hygiene')}>
                  {hygiene}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      data-section="maker-profile"
      data-variant="lead"
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div className={spacing.innerContainerClass}>
        <div className="grid items-center gap-6 md:grid-cols-2 md:gap-10">
          {image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt={alt}
              loading="eager"
              className="aspect-[4/3] w-full rounded-[var(--radius)] object-cover"
            />
          )}
          <div className={`text-start ${image ? '' : 'md:col-span-2'}`}>
            {name && (
              <h2
                className="font-display text-3xl font-bold leading-tight text-foreground sm:text-4xl"
                {...edit('name')}
              >
                {t(`From ${name}'s kitchen`, `من مطبخ ${name}`)}
              </h2>
            )}
            {(role || years) && (
              <p className="mt-2 text-base text-muted-foreground" {...edit('role')}>
                {[role, years].filter(Boolean).join(' · ')}
              </p>
            )}
            {story && (
              <p
                className="mt-4 line-clamp-5 text-base leading-relaxed text-foreground"
                {...edit('story')}
              >
                {story}
              </p>
            )}
            {hygiene && (
              <p className="mt-3 text-sm font-medium text-foreground" {...edit('hygiene')}>
                {hygiene}
              </p>
            )}
            {link && story && (
              <a
                href={link}
                className="mt-4 inline-flex min-h-11 min-w-11 items-center text-sm font-semibold text-foreground underline decoration-primary underline-offset-4"
              >
                {t('Read the story', 'اقرأ الحكاية')}
              </a>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
