'use client';

import { useT } from '@/i18n/useT';

export interface TaxStep {
  id: string;
  label: string;
  done: boolean;
  /** In-page anchor the step jumps to. */
  href: string;
}

/**
 * The order the tax page is meant to be done in (UX:TX-1): register the tax number, connect e-invoicing (when the
 * plan has it), then set the rates. A done step shows a tick; the first undone one is marked as the next move.
 */
export function TaxSteps({ steps }: { steps: TaxStep[] }) {
  const t = useT('tax.steps');
  const nextId = steps.find(s => !s.done)?.id;
  return (
    <nav aria-label={t('label')} className="rounded-md border border-border bg-card p-4">
      <ol className="flex flex-wrap gap-x-6 gap-y-2">
        {steps.map((step, i) => (
          <li key={step.id}>
            <a
              href={step.href}
              aria-current={step.id === nextId ? 'step' : undefined}
              className="inline-flex min-h-11 items-center gap-2 text-sm text-foreground"
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                  step.done
                    ? 'bg-success/10 text-success-ink'
                    : step.id === nextId
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                }`}
              >
                {step.done ? '✓' : i + 1}
              </span>
              <span className={step.id === nextId ? 'font-semibold' : undefined}>{step.label}</span>
              {step.done && <span className="sr-only">{t('done')}</span>}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
