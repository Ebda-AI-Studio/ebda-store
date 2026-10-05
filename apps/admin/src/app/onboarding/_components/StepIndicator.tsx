'use client';

import { useT } from '@/i18n/useT';
import { STEP_ORDER, type StepKey } from './types';

/**
 * Mobile: "Step 2 of 5" + a progress bar (one line, thumb-friendly).
 * md+: the labelled dots. Logical properties only, so it mirrors under RTL.
 */
export function StepIndicator({ current }: { current: StepKey }) {
  const t = useT('onboarding.flow');
  const tSteps = useT('onboarding.flow.steps');
  const index = STEP_ORDER.indexOf(current);
  const total = STEP_ORDER.length;
  return (
    <nav aria-label={t('title')} className="mb-5">
      <div className="md:hidden">
        <p className="text-sm font-medium text-foreground">
          {t('stepOf', { current: index + 1, total })}
        </p>
        <div
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={index + 1}
          aria-label={t('stepOf', { current: index + 1, total })}
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>
      </div>
      <ol className="hidden items-start gap-2 md:flex">
        {STEP_ORDER.map((key, i) => (
          <li key={key} className="flex min-w-0 flex-1 items-start">
            <span
              aria-current={key === current ? 'step' : undefined}
              className={`flex flex-col gap-2 text-xs ${
                i <= index ? 'font-medium text-foreground' : 'text-muted-foreground'
              }`}
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                  i <= index ? 'bg-primary text-primary-foreground' : 'bg-muted'
                }`}
              >
                {i + 1}
              </span>
              {tSteps(key)}
            </span>
            {i < total - 1 && (
              <span className="mt-3 ms-2 h-px flex-1 bg-border" aria-hidden="true" />
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
