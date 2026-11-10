'use client';

import type { ReactNode } from 'react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { AdminSkeletonPage } from './AdminSkeleton';
import { ErrorState } from './ErrorState';

export interface PageStateEmpty {
  title: string;
  body?: string;
  /** One next step: "ضيف أول منتج". */
  action?: { label: string; onClick?: () => void; href?: string };
}

interface PageStateProps {
  loading: boolean;
  /** Already-localized message (apiRequest localizes it, ERROR_AR). Never raw API text from your own code. */
  error?: string | null;
  /** Pass a value only when the load succeeded and there is nothing to show. */
  empty?: PageStateEmpty | null;
  onRetry?: () => void;
  children: ReactNode;
}

/**
 * One loading / error / empty wrapper (UX:CU-1), so a failed fetch is never rendered as an empty or zero state
 * (an unknown state must not look like "you have no orders"). Precedence: loading, error, empty, content.
 */
export function PageState({ loading, error, empty, onRetry, children }: PageStateProps) {
  if (loading) return <AdminSkeletonPage variants={['cards', 'table']} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (empty) {
    return (
      <div className="force-card flex flex-col items-center py-16 text-center">
        <h3 className="mb-2 text-xl font-semibold text-foreground">{empty.title}</h3>
        {empty.body && <p className="mb-6 max-w-sm text-muted-foreground">{empty.body}</p>}
        {empty.action &&
          (empty.action.href ? (
            <a href={empty.action.href} className={buttonVariants()}>
              {empty.action.label}
            </a>
          ) : (
            <Button onClick={empty.action.onClick}>{empty.action.label}</Button>
          ))}
      </div>
    );
  }
  return <>{children}</>;
}
