'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  TEMPLATE_FAMILIES,
  builtLookTemplates,
  getLook,
  looksForTemplate,
  type LookId,
  type LookTemplate,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';

interface LookPickerProps {
  value: LookId | null;
  onChange: (id: LookId) => void;
  locale: 'ar' | 'en';
}

/**
 * Pick a storefront look: one tab per BUILT template (registry order), its built looks under it.
 * The registry (`LOOKS`, `status`) is the only source of names, copy and what is offered, so a
 * template that ships appears here with no edit; this component owns no template list. The
 * store's current look (`value`) stays visible even if it is not built, so an existing store can
 * see where it is, but nothing unbuilt can be picked into.
 */
export function LookPicker({ value, onChange, locale }: LookPickerProps) {
  const t = useT('looks.picker');
  const uid = useId();
  const rtl = locale === 'ar';
  const current = getLook(value);
  const tabs: LookTemplate[] = builtLookTemplates();
  if (current && !tabs.includes(current.template)) tabs.push(current.template);
  const [active, setActive] = useState<LookTemplate>(() => current?.template ?? tabs[0]!);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const label = (id: LookTemplate) => {
    const family = TEMPLATE_FAMILIES.find(f => f.id === id);
    return family ? (rtl ? family.labelAr : family.labelEn) : id;
  };

  function focusIndex(index: number) {
    const n = tabs.length;
    const clamped = ((index % n) + n) % n;
    tabRefs.current[clamped]?.focus();
    setActive(tabs[clamped]!);
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
        focusIndex(tabs.length - 1);
        break;
      default:
        break;
    }
  }

  const looks = looksForTemplate(active).filter(l => l.status === 'built' || l.id === value);

  return (
    <div dir={rtl ? 'rtl' : 'ltr'} className="space-y-3">
      <div
        role="tablist"
        aria-label={t('tabs')}
        className="flex flex-wrap gap-2 border-b border-border"
      >
        {tabs.map((id, index) => {
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
