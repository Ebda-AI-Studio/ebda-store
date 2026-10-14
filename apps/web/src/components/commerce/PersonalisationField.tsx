'use client';
import { useId } from 'react';
import { activePersonalisation, cleanNote, personalisationLabel } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';
import { useNumerals } from '@/hooks/useNumerals';

/**
 * True while a REQUIRED personalisation is still empty. The PDP folds this into
 * its ONE add-to-cart disabled computation (main button, Dahab pinned bar and
 * any future sticky bar read the same value). The server enforces it too.
 */
export function personalisationMissing(raw: unknown, value: string): boolean {
  const cfg = activePersonalisation(raw);
  return !!cfg?.required && !cleanNote(value);
}

/**
 * The customer's per-item text ("Name to embroider"), above the add-to-cart
 * button. Renders nothing unless the merchant switched it on. One label, one
 * input, one helper line (the "write it first" hint while a required field is
 * empty, plus a live counter). Ink/muted tokens only: the accent stays on the CTA.
 */
export function PersonalisationField({
  config,
  value,
  onChange,
  className,
}: {
  config: unknown;
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const { language, t } = useLanguage();
  const { localize } = useNumerals();
  const id = useId();
  const cfg = activePersonalisation(config);
  if (!cfg) return null;

  const label = personalisationLabel(cfg, language === 'ar' ? 'ar' : 'en');
  const missing = cfg.required && !cleanNote(value);

  return (
    <div className={className ?? 'mt-6'}>
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        <bdi>{label}</bdi>
        {cfg.required && (
          <span aria-hidden="true" className="ms-0.5 text-muted-foreground">
            *
          </span>
        )}
      </label>
      <input
        id={id}
        type="text"
        dir="auto"
        value={value}
        maxLength={cfg.maxLength}
        required={cfg.required}
        aria-required={cfg.required}
        aria-describedby={`${id}-hint`}
        autoComplete="off"
        enterKeyHint="done"
        onChange={e => onChange(e.target.value)}
        className="mt-2 block h-11 w-full rounded-[var(--radius)] border border-border bg-background px-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p
        id={`${id}-hint`}
        className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground"
      >
        <span>{missing ? t(`Fill in “${label}” first`, `اكتب ${label} الأول`) : ''}</span>
        <span className="tabular-nums" aria-label={t('Characters used', 'عدد الحروف')}>
          {localize(value.length)}/{localize(cfg.maxLength)}
        </span>
      </p>
    </div>
  );
}
