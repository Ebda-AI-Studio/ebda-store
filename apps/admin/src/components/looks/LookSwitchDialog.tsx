'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '@/i18n/useT';

export type LookDesignChoice = 'keep' | 'reset';

interface LookSwitchDialogProps {
  lookName: string;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (design: LookDesignChoice) => void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';

/**
 * Confirm step when switching look: keep the merchant's colour/font edits (default) or start fresh.
 * Modal, labelled, Escape closes, Tab is trapped inside, focus returns to the opener on close.
 */
export function LookSwitchDialog({ lookName, saving, onCancel, onConfirm }: LookSwitchDialogProps) {
  const t = useT('looks.switch');
  const uid = useId();
  const [design, setDesign] = useState<LookDesignChoice>('keep');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input:checked')?.focus();
    return () => opener?.focus?.();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!saving) onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const options: { id: LookDesignChoice; label: string }[] = [
    { id: 'keep', label: t('keep') },
    { id: 'reset', label: t('reset') },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={`${uid}-desc`}
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-xl bg-card p-6 shadow-xl"
      >
        <h2 id={`${uid}-title`} className="mb-2 text-lg font-semibold text-foreground">
          {t('title', { lookName })}
        </h2>
        <p id={`${uid}-desc`} className="mb-4 text-sm text-muted-foreground">
          {t('body')}
        </p>
        <fieldset className="mb-6 space-y-2" disabled={saving}>
          <legend className="sr-only">{t('title', { lookName })}</legend>
          {options.map(o => (
            <label
              key={o.id}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <input
                type="radio"
                name={`${uid}-design`}
                checked={design === o.id}
                onChange={() => setDesign(o.id)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="flex items-center justify-end gap-3">
          <Button variant="outline" type="button" onClick={onCancel} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={() => onConfirm(design)} disabled={saving}>
            {saving ? t('saving') : t('confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
