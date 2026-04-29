'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { formatPrice } from '@/lib/format';
import type { ProductVariant, ProductOption } from '@/lib/api';
import { useLanguage } from '../contexts/LanguageContext';

interface VariantSelectorProps {
  variants: ProductVariant[];
  options: ProductOption[];
  onVariantSelect: (variant: ProductVariant | null) => void;
}

export function VariantSelector({ variants, options, onVariantSelect }: VariantSelectorProps) {
  const { t } = useLanguage();
  // Track selected value per option name
  const [selected, setSelected] = useState<Record<string, string>>({});

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
   * Return the imageUrl to preview next to a given option value pill, if
   * any. Picks the first variant matching `[optionName] = value` that has
   * an `imageUrl` set so the customer can see "200g" looks different from
   * "50g" before committing to a full selection. Returns undefined when
   * no matching variant has an image — caller hides the thumbnail.
   */
  function getThumbnailForValue(optionName: string, value: string): string | undefined {
    const match = variants.find(v => v.options[optionName] === value && v.imageUrl);
    return match?.imageUrl;
  }

  // Find the currently matched variant for live price/stock display
  const optionNames = options.map(o => o.name);
  const allPicked = optionNames.every(name => selected[name] !== undefined);
  const currentVariant = allPicked
    ? (variants.find(v => optionNames.every(name => v.options[name] === selected[name])) ?? null)
    : null;

  return (
    <div className="mt-6 space-y-5">
      {options.map(option => (
        <div key={option.name}>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-foreground">{option.name}:</span>
            {selected[option.name] && (
              <span className="text-sm text-muted-foreground">{selected[option.name]}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {option.values.map(value => {
              const isSelected = selected[option.name] === value;
              const available = isValueAvailable(option.name, value);
              const thumbnail = getThumbnailForValue(option.name, value);
              return (
                <button
                  key={value}
                  onClick={() => handleSelect(option.name, value)}
                  disabled={!available}
                  aria-pressed={isSelected}
                  title={!available ? t('Out of Stock', 'غير متوفر') : undefined}
                  className={[
                    'relative min-w-[2.75rem] rounded-lg border px-3 py-2 text-sm font-medium transition-all',
                    thumbnail ? 'inline-flex items-center gap-2' : '',
                    isSelected
                      ? 'border-primary bg-primary text-white shadow-md shadow-primary/25'
                      : available
                        ? 'border-border bg-background text-foreground hover:border-primary/50 hover:bg-muted'
                        : 'cursor-not-allowed border-border bg-muted text-muted-foreground opacity-50',
                  ].join(' ')}
                >
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
                  {value}
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
        </div>
      ))}

      {/* Live variant feedback */}
      {allPicked && (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
          {currentVariant ? (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-bold text-primary">
                  {formatPrice(currentVariant.price)}
                </span>
                {currentVariant.compareAtPrice &&
                  currentVariant.compareAtPrice > currentVariant.price && (
                    <span className="text-muted-foreground line-through text-sm">
                      {formatPrice(currentVariant.compareAtPrice)}
                    </span>
                  )}
              </div>
              {/* Stock count is rendered next to the qty stepper in
                  ProductDetailClient — surface the out-of-stock state
                  here only, otherwise it duplicated the count. */}
              {(currentVariant.inventory ?? 1) <= 0 && (
                <span className="font-medium text-destructive">
                  {t('Out of Stock', 'غير متوفر')}
                </span>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground">
              {t(
                'This combination is not available. Please choose a different option.',
                'هذه التركيبة غير متوفرة. يرجى اختيار خيار آخر.'
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
