'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  LOOK_TEMPLATES,
  TEMPLATE_FAMILIES,
  getLook,
  looksForTemplate,
  type LookId,
  type LookTemplate,
} from '@force/shared';
import { useT } from '@/i18n/useT';

interface LookPickerProps {
  value: LookId | null;
  onChange: (id: LookId) => void;
  locale: 'ar' | 'en';
}

/**
 * Pick a storefront look: five template tabs (registry order, Dahab first), three looks each.
 * The registry (`LOOKS`) is the only source of names and copy; this component owns no template list.
 */
export function LookPicker({ value, onChange, locale }: LookPickerProps) {
  const t = useT('looks.picker');
  const uid = useId();
  const rtl = locale === 'ar';
  const [active, setActive] = useState<LookTemplate>(
    () => getLook(value)?.template ?? LOOK_TEMPLATES[0]!
  );
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const label = (id: LookTemplate) => {
    const family = TEMPLATE_FAMILIES.find(f => f.id === id);
    return family ? (rtl ? family.labelAr : family.labelEn) : id;
  };

  function focusIndex(index: number) {
    const n = LOOK_TEMPLATES.length;
    const clamped = ((index % n) + n) % n;
    tabRefs.current[clamped]?.focus();
    setActive(LOOK_TEMPLATES[clamped]!);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    // Arrow keys follow the visual direction: in RTL the next tab is to the left.
    const step = rtl ? -1 : 1;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        focusIndex(index + step);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        focusIndex(index - step);
        break;
      case 'Home':
        e.preventDefault();
        focusIndex(0);
        break;
      case 'End':
        e.preventDefault();
        focusIndex(LOOK_TEMPLATES.length - 1);
        break;
      default:
        break;
    }
  }

  const looks = looksForTemplate(active);

  return (
    <div dir={rtl ? 'rtl' : 'ltr'} className="space-y-3">
      <div
        role="tablist"
        aria-label={t('tabs')}
        className="flex flex-wrap gap-2 border-b border-border"
      >
        {LOOK_TEMPLATES.map((id, index) => {
          const on = id === active;
          return (
            <button
              key={id}
              ref={el => {
                tabRefs.current[index] = el;
              }}
              id={`${uid}-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={`${uid}-panel`}
              tabIndex={on ? 0 : -1}
              onClick={() => setActive(id)}
              onKeyDown={e => onKeyDown(e, index)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors max-sm:inline-flex max-sm:min-h-11 max-sm:items-center ${
                on
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label(id)}
            </button>
          );
        })}
      </div>
      <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${active}`}>
        <div
          role="radiogroup"
          aria-labelledby={`${uid}-tab-${active}`}
          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          {looks.map(look => {
            const on = value === look.id;
            const name = rtl ? look.name.ar : look.name.en;
            return (
              <button
                key={look.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange(look.id)}
                className={`flex flex-col gap-2 rounded-lg border p-2 text-start transition-colors ${
                  on ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:bg-muted/40'
                }`}
              >
                {/* A fixed first-screen crop (360px wide webp); next/image adds nothing for a static asset. */}
                <img
                  src={`/looks/${look.id}.webp`}
                  alt={name}
                  loading="lazy"
                  decoding="async"
                  className="aspect-[4/5] w-full rounded-md border border-border bg-muted object-cover object-top"
                />
                <span className="block text-sm font-medium text-foreground">
                  {name}
                  {on && <span className="ms-2 text-xs text-primary-ink">{t('selected')}</span>}
                </span>
                <span className="block text-xs text-foreground/80">
                  {rtl ? look.forWhom.ar : look.forWhom.en}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {rtl ? look.idea.ar : look.idea.en}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
