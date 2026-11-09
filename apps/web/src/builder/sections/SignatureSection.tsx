'use client';

/**
 * Signature sections (T7, plan `2026-10-25-templates-match-mockups.md` P7): one distinctive moment
 * per template, so every look feels designed before the merchant touches it.
 *
 *   editorial-collage (Qamar)  three overlapping photos under one line
 *   piece-window      (Dahab)  one piece in a double hairline frame, like a jeweller's window
 *   spec-sheet        (Souq)   a product photo beside its key figures
 *   key-ingredients   (Jasmine) what is inside, one ingredient per line with what it does
 *   kitchen-days      (Lamma)  what is cooking on which day
 *
 * Shared rules, pinned by tests/unit/signature-sections-render.test.tsx:
 * - the heading speaks the store's own section voice (`SectionHeading`: kicker hairlines,
 *   data-zone typography, the pack's heading face), never a new separator;
 * - NO photo is never a broken box: the collage and the window fall back to type, the lists
 *   simply run full width;
 * - a list-driven section with fewer than two filled blocks renders nothing publicly and a hint
 *   in the editor (an unfilled feature renders nothing; presets never invent product claims);
 * - logical properties only (`start`/`end`, `ms`/`me`), so Arabic mirrors with no extra code;
 * - motion is CSS only and only under `motion-safe` (a slow photo lift on hover), never on text.
 */
import React from 'react';
import {
  sanitizeUrl,
  type BlockNode,
  type SectionPaddingMaxWidthVisibility,
  type TemplateId,
} from '@ebda/shared';
import { StoreAnchor } from '../../components/StoreLink';
import { ResponsiveImg } from '../../components/ResponsiveImg';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { SectionHeading } from '../../templates/shared/SectionHeading';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { EmptySectionHint, type EmptySectionKind } from '../render/EmptySectionHint';
import { imageMarker } from '../render/image-key';

export const SIGNATURE_TYPES = [
  'editorial-collage',
  'piece-window',
  'spec-sheet',
  'key-ingredients',
  'kitchen-days',
] as const;
export type SignatureType = (typeof SIGNATURE_TYPES)[number];

export function isSignatureType(type: string): type is SignatureType {
  return (SIGNATURE_TYPES as readonly string[]).includes(type);
}

export interface SignatureSettings extends SectionPaddingMaxWidthVisibility {
  kicker?: string;
  kickerAr?: string;
  title?: string;
  titleAr?: string;
  subtitle?: string;
  subtitleAr?: string;
  image?: string;
  alt?: string;
  altAr?: string;
  ctaText?: string;
  ctaTextAr?: string;
  ctaHref?: string;
  bgColor?: string;
}

const HINT: Record<SignatureType, EmptySectionKind> = {
  'editorial-collage': 'collage',
  'piece-window': 'pieceWindow',
  'spec-sheet': 'specSheet',
  'key-ingredients': 'keyIngredients',
  'kitchen-days': 'kitchenDays',
};

const MIN_ITEMS = 2;

/** A photo that lifts slowly on hover (motion-safe only); `rounded` follows the look's radius. */
const PHOTO_CLASS =
  'h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-700 motion-safe:ease-out motion-safe:group-hover:scale-[1.03]';

export function SignatureSection({
  type,
  settings,
  blocks,
  pack,
  editorMode = false,
}: {
  type: SignatureType;
  settings: SignatureSettings;
  blocks: BlockNode[];
  pack?: TemplateId;
  editorMode?: boolean;
}) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const ar = language === 'ar';
  const pick = (en?: unknown, a?: unknown) => {
    const e = typeof en === 'string' ? en.trim() : '';
    const r = typeof a === 'string' ? a.trim() : '';
    return ar ? r || e : e || r;
  };
  const edit = (key: string): Record<string, string> =>
    editorMode ? { 'data-builder-setting': ar ? `${key}Ar` : key } : {};
  const blockMark = (id: string) => (editorMode ? { 'data-builder-block': id } : {});
  const visible = blocks.filter(b => b.hidden !== true);
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  const title = pick(settings.title, settings.titleAr);
  const image = str(settings.image);
  const alt = pick(settings.alt, settings.altAr) || title;
  const ctaText = pick(settings.ctaText, settings.ctaTextAr);
  const ctaHref = storeUrl(sanitizeUrl(settings.ctaHref || '/products', '/products'));

  // ---- what each type needs before it is worth showing
  const photos = visible
    .filter(b => b.type === 'photo' && str(b.settings.image))
    .slice(0, 3)
    .map(b => ({
      id: b.id,
      src: str(b.settings.image),
      alt: pick(b.settings.alt, b.settings.altAr),
    }));
  const specs = visible
    .filter(b => b.type === 'spec')
    .map(b => ({
      id: b.id,
      value: str(b.settings.value),
      label: pick(b.settings.label, b.settings.labelAr),
    }))
    .filter(x => x.value && x.label)
    .slice(0, 4);
  const ingredients = visible
    .filter(b => b.type === 'ingredient')
    .map(b => ({
      id: b.id,
      name: pick(b.settings.name, b.settings.nameAr),
      benefit: pick(b.settings.benefit, b.settings.benefitAr),
    }))
    .filter(x => x.name)
    .slice(0, 6);
  const days = visible
    .filter(b => b.type === 'day')
    .map(b => ({
      id: b.id,
      day: pick(b.settings.day, b.settings.dayAr),
      dish: pick(b.settings.dish, b.settings.dishAr),
      note: pick(b.settings.note, b.settings.noteAr),
      image: str(b.settings.image),
    }))
    .filter(x => x.day && x.dish)
    .slice(0, 7);

  const empty =
    type === 'editorial-collage'
      ? photos.length === 0 && !title
      : type === 'piece-window'
        ? !image && !title
        : type === 'spec-sheet'
          ? specs.length < MIN_ITEMS
          : type === 'key-ingredients'
            ? ingredients.length < MIN_ITEMS
            : days.length < MIN_ITEMS;
  if (empty) return editorMode ? <EmptySectionHint kind={HINT[type]} /> : null;

  const spacing = sectionSpacingClasses(settings, store.look);
  const heading = (
    <SectionHeading
      title={settings.title}
      titleAr={settings.titleAr}
      kicker={settings.kicker}
      kickerAr={settings.kickerAr}
      subtitle={settings.subtitle}
      subtitleAr={settings.subtitleAr}
      isRtl={ar}
      pack={pack}
      sectionBgColor={settings.bgColor}
    />
  );
  const cta = ctaText ? (
    <div className="mt-6 flex justify-center">
      <StoreAnchor
        href={ctaHref}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius)] bg-primary px-6 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        {...edit('ctaText')}
      >
        {ctaText}
      </StoreAnchor>
    </div>
  ) : null;

  let body: React.ReactNode = null;
  if (type === 'editorial-collage') {
    body = photos.length > 0 ? <Collage photos={photos} editorMode={editorMode} /> : null;
  } else if (type === 'piece-window') {
    // No photo: the frame holds the words instead, so the window is still a window.
    return (
      <Shell type={type} settings={settings} spacing={spacing}>
        <div className="mx-auto w-full max-w-sm border border-border p-2 sm:max-w-md sm:p-2.5">
          <div className="border border-border">
            {image ? (
              <div
                className="group aspect-[4/4.6] overflow-hidden"
                {...imageMarker(editorMode, 'image')}
              >
                <ResponsiveImg
                  src={image}
                  alt={alt}
                  sizes="(max-width: 640px) 90vw, 448px"
                  maxWidth={1200}
                  className={PHOTO_CLASS}
                />
              </div>
            ) : (
              <div className="flex min-h-56 items-center justify-center bg-card px-4 py-10">
                <div className="w-full">{heading}</div>
              </div>
            )}
          </div>
        </div>
        {image && <div className="mt-6">{heading}</div>}
        {cta}
      </Shell>
    );
  } else if (type === 'spec-sheet') {
    body = (
      <div
        className={`mx-auto grid max-w-4xl items-center gap-6 ${image ? 'md:grid-cols-2 md:gap-10' : ''}`}
      >
        {image && (
          <div
            className="group mx-auto aspect-square w-full max-w-xs overflow-hidden rounded-[var(--radius)] bg-card md:max-w-none"
            {...imageMarker(editorMode, 'image')}
          >
            <ResponsiveImg
              src={image}
              alt={alt}
              sizes="(max-width: 768px) 320px, 448px"
              maxWidth={1200}
              className={PHOTO_CLASS.replace('object-cover', 'object-contain')}
            />
          </div>
        )}
        <dl
          // The columns follow the count, so an odd number of figures never leaves an empty cell.
          className={`grid gap-px overflow-hidden rounded-[var(--radius)] border border-border bg-border ${
            specs.length === 3 ? 'grid-cols-3' : 'grid-cols-2'
          } ${!image && specs.length === 4 ? 'sm:grid-cols-4' : ''}`}
        >
          {specs.map(s => (
            <div
              key={s.id}
              className="flex flex-col-reverse justify-end gap-1 bg-card p-3 sm:p-4"
              {...blockMark(s.id)}
            >
              <dt className="text-sm text-muted-foreground" {...edit('label')}>
                {s.label}
              </dt>
              <dd className="font-display text-3xl font-bold leading-none tabular-nums text-foreground sm:text-4xl">
                <bdi>{s.value}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  } else if (type === 'key-ingredients') {
    body = (
      <div
        className={`mx-auto grid max-w-4xl items-center gap-4 sm:gap-8 ${image ? 'grid-cols-[minmax(0,5fr)_minmax(0,7fr)]' : ''}`}
      >
        {image && (
          <div
            className="group aspect-[3/4] overflow-hidden rounded-[var(--radius)] bg-card"
            {...imageMarker(editorMode, 'image')}
          >
            <ResponsiveImg
              src={image}
              alt={alt}
              sizes="(max-width: 768px) 40vw, 360px"
              maxWidth={900}
              className={PHOTO_CLASS}
            />
          </div>
        )}
        <ul className="divide-y divide-border">
          {ingredients.map(i => (
            <li key={i.id} className="flex gap-3 py-3 first:pt-0 last:pb-0" {...blockMark(i.id)}>
              <span aria-hidden className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />
              <div className="min-w-0">
                <p className="font-display text-base font-bold text-foreground" {...edit('name')}>
                  {i.name}
                </p>
                {i.benefit && (
                  <p className="text-sm leading-relaxed text-muted-foreground" {...edit('benefit')}>
                    {i.benefit}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  } else {
    body = (
      <ul
        aria-label={title || t('Kitchen days', 'أيام المطبخ')}
        // A row that scrolls on a phone is a focusable region (keyboard users can scroll it).
        tabIndex={0}
        className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:mx-0 sm:px-0 md:grid md:snap-none md:overflow-visible"
        style={{ gridTemplateColumns: `repeat(${Math.min(days.length, 4)}, minmax(0, 1fr))` }}
      >
        {days.map(d => (
          <li
            key={d.id}
            className="flex w-[42%] shrink-0 snap-start flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-card sm:w-[30%] md:w-auto"
            {...blockMark(d.id)}
          >
            {d.image && (
              <div className="group aspect-[4/3] overflow-hidden bg-muted">
                <ResponsiveImg
                  src={d.image}
                  alt=""
                  sizes="(max-width: 768px) 42vw, 280px"
                  maxWidth={800}
                  className={PHOTO_CLASS}
                />
              </div>
            )}
            <div className="flex flex-1 flex-col gap-1 p-3">
              <p className="text-sm font-semibold text-primary" {...edit('day')}>
                {d.day}
              </p>
              <p
                className="font-display text-lg font-bold leading-snug text-foreground"
                {...edit('dish')}
              >
                {d.dish}
              </p>
              {d.note && (
                <p className="text-sm text-muted-foreground" {...edit('note')}>
                  {d.note}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  // The heading sits on the same measure as the body under it, so a start-aligned pack heading
  // lines up with the collage / list instead of floating at the far edge of a wide page.
  const measure =
    type === 'editorial-collage' ? 'max-w-xl' : type === 'kitchen-days' ? '' : 'max-w-4xl';
  return (
    <Shell type={type} settings={settings} spacing={spacing}>
      <div className={measure ? `mx-auto ${measure}` : undefined}>{heading}</div>
      {body}
      {cta}
    </Shell>
  );
}

function Shell({
  type,
  settings,
  spacing,
  children,
}: {
  type: SignatureType;
  settings: SignatureSettings;
  spacing: ReturnType<typeof sectionSpacingClasses>;
  children: React.ReactNode;
}) {
  const { store } = useStore();
  return (
    <section
      data-section={type}
      data-signature
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div className={spacing.innerContainerClass}>{children}</div>
    </section>
  );
}

/**
 * One photo stands alone (4/5). Two or three overlap: the first takes 62% of the width at full
 * height, the others sit on the end side over a ring in the section's own colour, so the overlap
 * reads as paper laid on paper. Positions are logical, so Arabic lays the collage out mirrored.
 */
function Collage({
  photos,
  editorMode,
}: {
  photos: Array<{ id: string; src: string; alt: string }>;
  editorMode: boolean;
}) {
  const mark = (id: string) => (editorMode ? { 'data-builder-block': id } : {});
  if (photos.length === 1) {
    const [p] = photos;
    return (
      <div
        className="group mx-auto aspect-[4/5] w-full max-w-sm overflow-hidden rounded-[var(--radius)] bg-muted"
        {...mark(p.id)}
      >
        <ResponsiveImg
          src={p.src}
          alt={p.alt}
          sizes="(max-width: 640px) 90vw, 384px"
          maxWidth={1200}
          className={PHOTO_CLASS}
        />
      </div>
    );
  }
  const tile =
    'group absolute overflow-hidden rounded-[var(--radius)] bg-muted ring-4 ring-[hsl(var(--bg-page))]';
  const [main, second, third] = photos;
  return (
    <div className="relative mx-auto aspect-[1/0.95] w-full max-w-xl sm:aspect-[1/0.8]">
      <div
        className="group absolute inset-y-0 start-0 w-[62%] overflow-hidden rounded-[var(--radius)] bg-muted"
        {...mark(main.id)}
      >
        <ResponsiveImg
          src={main.src}
          alt={main.alt}
          sizes="(max-width: 640px) 60vw, 360px"
          maxWidth={1200}
          className={PHOTO_CLASS}
        />
      </div>
      <div
        className={`${tile} end-0 ${third ? 'top-[5%] h-[52%]' : 'top-[18%] h-[64%]'} w-[44%]`}
        {...mark(second.id)}
      >
        <ResponsiveImg
          src={second.src}
          alt={second.alt}
          sizes="(max-width: 640px) 44vw, 260px"
          maxWidth={900}
          className={PHOTO_CLASS}
        />
      </div>
      {third && (
        <div className={`${tile} bottom-0 end-[6%] h-[40%] w-[38%]`} {...mark(third.id)}>
          <ResponsiveImg
            src={third.src}
            alt={third.alt}
            sizes="(max-width: 640px) 38vw, 220px"
            maxWidth={900}
            className={PHOTO_CLASS}
          />
        </div>
      )}
    </div>
  );
}
