'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { activePersonalisation, cleanNote } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';
import { useNumerals } from '@/hooks/useNumerals';

/**
 * True while a REQUIRED personalisation is still empty. The PDP keeps this as its
 * ONE `noteMissing` signal, beside its ONE `addDisabled` (every buy button reads
 * both): a tap while only the note is missing nudges the field instead of adding.
 * The server enforces it too.
 */
export function personalisationMissing(raw: unknown, value: string): boolean {
  const cfg = activePersonalisation(raw);
  return !!cfg?.required && !cleanNote(value);
}

/**
 * The customer's per-item text ("Name to embroider"), above the add-to-cart
 * button. Renders nothing unless the merchant switched it on. One label, one
 * input, one helper line. Ink/muted tokens only: the accent stays on the CTA.
 *
 * - Label: the merchant's label in the ACTIVE language, else the platform default
 *   "Personalisation" / "التخصيص". A control label is never borrowed from the other
 *   language (F4: "الاسم للتطريز" inside an English sentence, bidi-flipped quotes).
 * - The "fill it in first" line waits for intent (F6): it shows only after the field is
 *   blurred empty, or after a blocked add-to-cart (`nudge` increments). Until then the
 *   helper line carries only the counter.
 * - `nudge`: each increment (a tap on add-to-cart while the note is the ONLY blocker)
 *   scrolls the field into view, focuses it and reveals the hint. The page never adds.
 */
export function PersonalisationField({
  config,
  value,
  onChange,
  nudge = 0,
  className,
}: {
  config: unknown;
  value: string;
  onChange: (v: string) => void;
  /** Bumped by the page when a tap on add-to-cart was blocked by this empty field. */
  nudge?: number;
  className?: string;
}) {
  const { language, t } = useLanguage();
  const { localize } = useNumerals();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (nudge <= 0) return;
    setTouched(true);
    const el = input.current;
    if (!el) return;
    let smooth = true;
    try {
      smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    } catch {
      /* no matchMedia: smooth */
    }
    el.scrollIntoView?.({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    el.focus({ preventScroll: true });
  }, [nudge]);

  const cfg = activePersonalisation(config);
  if (!cfg) return null;

  const label =
    (language === 'ar' ? cfg.labelAr : cfg.label)?.trim() || t('Personalisation', 'التخصيص');
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
        ref={input}
        id={id}
        type="text"
        dir="auto"
        value={value}
        maxLength={cfg.maxLength}
        required={cfg.required}
        aria-required={cfg.required}
        aria-invalid={missing && touched ? true : undefined}
        aria-describedby={`${id}-hint`}
        autoComplete="off"
        enterKeyHint="done"
        onChange={e => onChange(e.target.value)}
        onBlur={() => setTouched(true)}
        className="mt-2 block h-11 w-full rounded-[var(--radius)] border border-border bg-background px-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:max-w-sm"
      />
      <p
        id={`${id}-hint`}
        className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground md:max-w-sm"
      >
        <span data-testid="personalisation-hint">
          {missing && touched ? t(`Fill in “${label}” first`, `اكتب ${label} أولاً`) : ''}
        </span>
        <span className="tabular-nums" aria-label={t('Characters used', 'عدد الحروف')}>
          {localize(value.length)}/{localize(cfg.maxLength)}
        </span>
      </p>
    </div>
  );
}
