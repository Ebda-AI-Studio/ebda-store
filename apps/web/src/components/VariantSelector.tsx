'use client';

import { useState, useEffect } from 'react';
import { formatPrice } from '@/lib/format';
import type { ProductVariant, ProductOption } from '@/lib/api';

interface VariantSelectorProps {
  variants: ProductVariant[];
  options: ProductOption[];
  onVariantSelect: (variant: ProductVariant | null) => void;
}

export function VariantSelector({ variants, options, onVariantSelect }: VariantSelectorProps) {
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
    setSelected(prev => ({ ...prev, [optionName]: value }));
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
              return (
                <button
                  key={value}
                  onClick={() => handleSelect(option.name, value)}
                  disabled={!available}
                  aria-pressed={isSelected}
                  title={!available ? 'Out of stock' : undefined}
                  className={[
                    'relative min-w-[2.75rem] rounded-lg border px-3 py-2 text-sm font-medium transition-all',
                    isSelected
                      ? 'border-primary bg-primary text-white shadow-md shadow-primary/25'
                      : available
                        ? 'border-border bg-background text-foreground hover:border-primary/50 hover:bg-muted'
                        : 'cursor-not-allowed border-border bg-muted text-muted-foreground opacity-50',
                  ].join(' ')}
                >
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
              <span
                className={`font-medium ${
                  (currentVariant.inventory ?? 1) > 0 ? 'text-emerald-600' : 'text-red-600'
                }`}
              >
                {(currentVariant.inventory ?? 1) > 0
                  ? currentVariant.inventory !== undefined
                    ? `${currentVariant.inventory} in stock`
                    : 'In stock'
                  : 'Out of stock'}
              </span>
            </div>
          ) : (
            <p className="text-muted-foreground">
              This combination is not available. Please choose a different option.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
