'use client';

import { useState, useEffect, useId, useRef, type ReactNode } from 'react';
import Image from 'next/image';
import type { ProductVariant, ProductOption } from '@/lib/api';
import { useLanguage } from '../contexts/LanguageContext';
import { localizeOptionName, localizeOptionValue } from '@/lib/option-localization';
import { autoSelection } from '@/lib/single-variant';
import { swatchOf } from '@ebda/shared';

interface VariantSelectorProps {
  variants: ProductVariant[];
  options: ProductOption[];
  onVariantSelect: (variant: ProductVariant | null) => void;
  /** Fires when the shopper taps a pill (never for the auto-selected single
   *  variant), so the page can tell a real pick from the pre-selection. */
  onShopperSelect?: () => void;
  /** Fires with the (possibly PARTIAL) pick map on every change — the 3D
   *  viewer recolours on "Metal: Gold" before a size is chosen. */
  onSelectionChange?: (selected: Record<string, string>) => void;
  /** Colour dot for a pill (a 3D colour/metal binding), or undefined. */
  swatchColor?: (optionName: string, value: string) => string | undefined;
  /**
   * `pill` (default, every existing store): filled primary pill when picked.
   * `swatch` (Dahab): outlined chips with a metal-colour dot for gold
   * colours. Presentation only — selection and availability logic is shared.
   */
  appearance?: 'pill' | 'swatch';
  /**
   * Size-guide trigger (B0 Task 9). Rendered beside the label of the option named like a size
   * (`isSizeOption`), else once under the selector. Omitted = nothing renders.
   */
  sizeGuide?: ReactNode;
  /**
   * Bumped by the page when add-to-cart was tapped with an option still unset
   * (C-02). Each increment scrolls to the FIRST unset option group, focuses it,
   * rings it and says what is missing in a live region — the buy button itself
   * stays full-weight and enabled (it is never painted disabled for a choice the
   * shopper can still make). Same shape as `PersonalisationField`'s `nudge`.
   */
  nudge?: number;
}

/**
 * An option the size guide belongs to: "Size", "Ring size", "المقاس", "مقاسات", "الحجم"
 * (`localizeOptionName` maps Size to الحجم)...
 */
export function isSizeOption(option: { name: string; nameAr?: string | null }): boolean {
  return /size|مقاس|مقاسات|الحجم/i.test(`${option.name} ${option.nameAr ?? ''}`);
}

/** Metal colour dot for a gold-colour option value (`swatch` appearance). */
export function metalSwatchColor(value: string, valueAr?: string | null): string | null {
  const v = `${value} ${valueAr ?? ''}`.toLowerCase();
  if (/rose|pink|وردي|روز/.test(v)) return '#D9A08B';
  if (/white|platinum|silver|أبيض|ابيض|فضة|فضي|بلاتين/.test(v)) return '#E4E4E0';
  if (/yellow|gold|أصفر|اصفر|ذهبي/.test(v)) return '#D4AF5A';
  return null;
}

export function VariantSelector({
  variants,
  options,
  onVariantSelect,
  onShopperSelect,
  onSelectionChange,
  swatchColor,
  appearance = 'pill',
  sizeGuide,
  nudge = 0,
}: VariantSelectorProps) {
  const swatch = appearance === 'swatch';
  const { t, isRtl } = useLanguage();
  const uid = useId();
  // The option group a blocked add-to-cart pointed at (cleared once it is picked).
  const [nudged, setNudged] = useState<string | null>(null);
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Track selected value per option name. A product with exactly one
  // (tappable) variant starts with it picked — there is nothing to choose.
  const [selected, setSelected] = useState<Record<string, string>>(() =>
    autoSelection(
      variants,
      options.map(o => o.name)
    )
  );

  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected, onSelectionChange]);

  // A blocked add: go to the first option still missing. With every option
  // picked but no matching variant (an unavailable combination) the first
  // group is the place to change.
  useEffect(() => {
    if (nudge <= 0) return;
    const target = options.find(o => selected[o.name] === undefined) ?? options[0];
    if (!target) return;
    setNudged(target.name);
    const el = groupRefs.current[target.name];
    if (!el) return;
    let smooth = true;
    try {
      smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    } catch {
      /* no matchMedia: smooth */
    }
    el.scrollIntoView?.({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    el.focus({ preventScroll: true });
    // Only the nudge counter drives this; `selected`/`options` are read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudge]);

  // Derive the matching variant whenever selections change
  useEffect(() => {
    const optionNames = options.map(o => o.name);
    // Only try to match once every option has a value chosen
    const allPicked = optionNames.every(name => selected[name] !== undefined);
    if (!allPicked) {
      onVariantSelect(null);
      return;
    }

    const match = variants.find(v => optionNames.every(name => v.options[name] === selected[name]));
    onVariantSelect(match ?? null);
  }, [selected, variants, options, onVariantSelect]);

  if (!options || options.length === 0) return null;

  function handleSelect(optionName: string, value: string) {
    onShopperSelect?.();
    if (nudged === optionName) setNudged(null);
    // Toggle: clicking an already-selected pill clears it. Customer
    // feedback was that a single-axis product (e.g. "4 liters / 6 liters")
    // looked like a forced choice with no escape — they expected to be
    // able to deselect and see the base product again.
    setSelected(prev => {
      if (prev[optionName] === value) {
        const next = { ...prev };
        delete next[optionName];
        return next;
      }
      return { ...prev, [optionName]: value };
    });
  }

  /**
   * Determine whether a particular option value is currently available.
   * A value is available if at least one variant with that value still has
   * inventory > 0 (or inventory is undefined, meaning untracked).
   */
  function isValueAvailable(optionName: string, value: string): boolean {
    // Build a partial selection with the candidate value applied
    const partialSelection = { ...selected, [optionName]: value };
    return variants.some(v => {
      // The variant must satisfy every already-selected option AND this candidate
      const matches = Object.entries(partialSelection).every(
        ([name, val]) => v.options[name] === val
      );
      if (!matches) return false;
      // Treat null/undefined inventory as in-stock (untracked)
      return v.inventory === undefined || v.inventory === null || v.inventory > 0;
    });
  }

  /**
   * Thumbnail for a value pill, only when it is TRUE of the value: every
   * variant that carries `[optionName] = value` shares the same non-null
   * imageUrl. A single-axis "200g" qualifies; on a multi-axis product one
   * Rose/S/52 photo must not appear on the "S" and "52" chips. Returns
   * undefined otherwise, and the caller hides the thumbnail.
   */
  function getThumbnailForValue(optionName: string, value: string): string | undefined {
    const matching = variants.filter(v => v.options[optionName] === value);
    const first = matching[0]?.imageUrl;
    if (!first) return undefined;
    return matching.every(v => v.imageUrl === first) ? first : undefined;
  }

  // Find the currently matched variant for live price/stock display
  const optionNames = options.map(o => o.name);
  const allPicked = optionNames.every(name => selected[name] !== undefined);
  const currentVariant = allPicked
    ? (variants.find(v => optionNames.every(name => v.options[name] === selected[name])) ?? null)
    : null;
  // The guide sits by the first size-like option; with none, under the whole selector.
  const sizeGuideOption = sizeGuide ? options.find(isSizeOption)?.name : undefined;

  return (
    <div className="mt-6 space-y-5">
      {options.map(option => {
        // Localise the axis label (الحجم vs Size). Merchant Arabic wins; else
        // the option-name map (Size→الحجم …); else English.
        const axisLabel = localizeOptionName(
          option.name,
          option.nameAr,
          isRtl,
          option.values.map(v => v.value)
        );
        // Display label for the currently-selected value.
        const selectedValue = selected[option.name];
        const selectedDisplay = selectedValue
          ? (() => {
              const found = option.values.find(v => v.value === selectedValue);
              return localizeOptionValue(selectedValue, found?.valueAr, isRtl);
            })()
          : null;
        // An option with >=1 swatch value renders round swatches; values with
        // neither hex nor image fall back to a text chip (never an empty circle).
        const swatchOption = option.values.some(v => swatchOf(v));
        const optionIndex = options.indexOf(option);
        const labelId = `${uid}-label-${optionIndex}`;
        const hintId = `${uid}-hint-${optionIndex}`;
        const isNudged = nudged === option.name;
        return (
          <div
            key={option.name}
            ref={el => {
              groupRefs.current[option.name] = el;
            }}
            role="group"
            aria-labelledby={labelId}
            aria-describedby={hintId}
            aria-invalid={isNudged ? true : undefined}
            tabIndex={-1}
            data-option-group={option.name}
            data-nudged={isNudged ? '' : undefined}
            className={[
              'rounded-[var(--radius)] outline-none',
              isNudged ? 'ring-2 ring-ring ring-offset-4 ring-offset-background' : '',
            ].join(' ')}
          >
            <div className="flex items-center gap-2 mb-2">
              <span
                id={labelId}
                className={
                  swatch ? 'text-sm text-muted-foreground' : 'text-sm font-medium text-foreground'
                }
              >
                {axisLabel}:
              </span>
              {selectedDisplay && (
                <span className="text-sm text-muted-foreground">{selectedDisplay}</span>
              )}
              {option.name === sizeGuideOption && (
                <span className="-my-3 ms-auto">{sizeGuide}</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {option.values.map(({ value, valueAr, swatchHex, swatchImageUrl }) => {
                const sw = swatchOption ? swatchOf({ swatchHex, swatchImageUrl }) : null;
                const isSelected = selected[option.name] === value;
                const available = isValueAvailable(option.name, value);
                const thumbnail = getThumbnailForValue(option.name, value);
                const dotColor = thumbnail ? undefined : swatchColor?.(option.name, value);
                // Pill text: merchant Arabic wins; else unit tokens are
                // localised ("185 Gram" → "185 جرام"); else English.
                const pillLabel = localizeOptionValue(value, valueAr, isRtl);
                const metal = swatch ? metalSwatchColor(value, valueAr) : null;
                if (sw) {
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => handleSelect(option.name, value)}
                      disabled={!available}
                      aria-pressed={isSelected}
                      aria-label={
                        available ? pillLabel : `${pillLabel}, ${t('Sold out', 'نفدت الكمية')}`
                      }
                      title={!available ? t('Out of Stock', 'غير متوفر') : pillLabel}
                      className={[
                        'relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full before:absolute before:-inset-1.5 before:content-[""] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isSelected
                          ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                          : 'ring-1 ring-foreground/35',
                        available ? '' : 'cursor-not-allowed opacity-50',
                      ].join(' ')}
                    >
                      <span
                        data-swatch-hex={sw.hex ?? undefined}
                        className="block h-full w-full overflow-hidden rounded-full"
                        style={sw.imageUrl ? undefined : { backgroundColor: sw.hex ?? undefined }}
                      >
                        {sw.imageUrl && (
                          <img src={sw.imageUrl} alt="" className="h-full w-full object-cover" />
                        )}
                      </span>
                      {!available && (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0 text-foreground/50"
                        >
                          <svg
                            className="h-full w-full"
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                          >
                            <line
                              x1="14"
                              y1="86"
                              x2="86"
                              y2="14"
                              stroke="currentColor"
                              strokeWidth="4"
                            />
                          </svg>
                        </span>
                      )}
                    </button>
                  );
                }
                return (
                  <button
                    key={value}
                    onClick={() => handleSelect(option.name, value)}
                    disabled={!available}
                    aria-pressed={isSelected}
                    title={!available ? t('Out of Stock', 'غير متوفر') : undefined}
                    className={
                      swatch
                        ? [
                            'relative inline-flex min-h-[44px] min-w-[3rem] items-center justify-center gap-2 rounded-[var(--radius)] border px-3.5 text-sm tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            isSelected
                              ? 'border-primary text-foreground ring-1 ring-inset ring-primary'
                              : available
                                ? 'border-border text-foreground/85 hover:border-primary/60'
                                : 'cursor-not-allowed border-border text-muted-foreground line-through opacity-50',
                          ].join(' ')
                        : [
                            'relative min-w-[2.75rem] rounded-lg border px-3 py-2 text-sm font-medium transition-all',
                            thumbnail || dotColor ? 'inline-flex items-center gap-2' : '',
                            isSelected
                              ? 'border-primary bg-primary text-white shadow-md shadow-primary/25'
                              : available
                                ? 'border-border bg-background text-foreground hover:border-primary/50 hover:bg-muted'
                                : 'cursor-not-allowed border-border bg-muted text-muted-foreground line-through opacity-50',
                          ].join(' ')
                    }
                  >
                    {metal && (
                      <span
                        aria-hidden="true"
                        className="inline-block h-4 w-4 shrink-0 rounded-full ring-1 ring-foreground/20"
                        style={{
                          background: `radial-gradient(circle at 35% 30%, #fff8 0, transparent 45%), ${metal}`,
                        }}
                      />
                    )}
                    {thumbnail && (
                      <span
                        aria-hidden="true"
                        className="inline-block h-6 w-6 overflow-hidden rounded bg-muted shrink-0"
                      >
                        <Image
                          src={thumbnail}
                          alt=""
                          width={24}
                          height={24}
                          className="h-full w-full object-cover"
                        />
                      </span>
                    )}
                    {dotColor && (
                      <span
                        aria-hidden="true"
                        className="inline-block h-4 w-4 shrink-0 rounded-full border border-foreground/20"
                        style={{ backgroundColor: dotColor }}
                      />
                    )}
                    {pillLabel}
                    {/* Strikethrough diagonal line for unavailable values */}
                    {!available && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-0 flex items-center justify-center pointer-events-none"
                      >
                        <svg
                          className="w-full h-full absolute inset-0 text-muted-foreground/40"
                          viewBox="0 0 100 100"
                          preserveAspectRatio="none"
                        >
                          <line
                            x1="0"
                            y1="100"
                            x2="100"
                            y2="0"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                        </svg>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {/* Live region: present before it has text, so the message is
                announced when a blocked add fills it (C-02). */}
            <p
              id={hintId}
              aria-live="polite"
              data-testid="variant-nudge"
              className={isNudged ? 'mt-2 text-sm font-medium text-destructive-ink' : 'sr-only'}
            >
              {isNudged
                ? selectedValue === undefined
                  ? t(`Choose ${axisLabel}`, `اختر ${axisLabel}`)
                  : t(
                      'This combination is not available. Please choose a different option.',
                      'هذه التركيبة غير متوفرة. يرجى اختيار خيار آخر.'
                    )
                : ''}
            </p>
          </div>
        );
      })}

      {sizeGuide && !sizeGuideOption && <div className="-mt-2">{sizeGuide}</div>}

      {/* Feedback panel only shows when something is wrong: variant
          out of stock, or no variant matches the picked combo. The
          price/inventory of a valid variant is reflected in the main
          product price + qty stepper area on ProductDetailClient, so a
          duplicate display here was just visual noise. */}
      {allPicked && currentVariant && (currentVariant.inventory ?? 1) <= 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          <span className="font-medium text-destructive-ink">{t('Out of Stock', 'غير متوفر')}</span>
        </div>
      )}
      {allPicked && !currentVariant && (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
          <p className="text-muted-foreground">
            {t(
              'This combination is not available. Please choose a different option.',
              'هذه التركيبة غير متوفرة. يرجى اختيار خيار آخر.'
            )}
          </p>
        </div>
      )}
    </div>
  );
}
