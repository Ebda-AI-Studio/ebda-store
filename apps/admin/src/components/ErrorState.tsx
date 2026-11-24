'use client';

import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { planGateFor } from '../lib/plan-gate-registry';
import { PlanLockedCard } from './PlanLockedCard';

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryText?: string;
}

export function ErrorState({ title, message, onRetry, retryText }: ErrorStateProps) {
  const t = useT('components.errorState');
  const resolvedTitle = title ?? t('defaultTitle');
  const resolvedRetryText = retryText ?? t('defaultRetry');
  // A plan refusal is an upgrade card, not an error with a retry that cannot succeed (lib/plan-gate-registry.ts).
  const gate = planGateFor(message);
  if (gate) return <PlanLockedCard info={gate} message={message} />;
  return (
    <div className="force-card py-16">
      <div className="flex flex-col items-center text-center">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-lg bg-destructive/5">
          <svg
            className="h-10 w-10 text-destructive"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">{resolvedTitle}</h3>
        <p className="text-muted-foreground mb-6 max-w-sm">{message}</p>
        {onRetry && (
          <Button onClick={onRetry} className="gap-2">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            {resolvedRetryText}
          </Button>
        )}
      </div>
    </div>
  );
}
