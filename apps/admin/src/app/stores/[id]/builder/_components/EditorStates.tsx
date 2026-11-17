'use client';

/**
 * The editor's two whole-screen states (editor premium F63): a skeleton shell in the shape of the
 * editor while it opens, and a named error with a retry when it cannot. Shapes only (no spinner
 * text); the pulse stops under `prefers-reduced-motion`.
 */
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';

const bar = 'rounded-md bg-muted motion-safe:animate-pulse';

export function EditorSkeleton() {
  const t = useT('builder');
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex h-screen flex-col bg-background"
      data-testid="editor-skeleton"
    >
      <span className="sr-only">{t('loading')}</span>
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex items-center gap-2">
          <div className={`${bar} h-8 w-28`} />
          <div className={`${bar} h-8 w-24`} />
        </div>
        <div className={`${bar} hidden h-8 w-28 md:block`} />
        <div className="flex items-center gap-2">
          <div className={`${bar} h-6 w-16 rounded-full`} />
          <div className={`${bar} h-8 w-20`} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-80 shrink-0 flex-col gap-2 border-e border-border p-3 lg:flex">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} className={`${bar} h-9`} />
          ))}
        </div>
        <div className="flex-1 bg-muted/40 p-4">
          <div className={`${bar} mx-auto h-full max-w-3xl bg-card`} />
        </div>
        <div className="hidden w-80 shrink-0 flex-col gap-3 border-s border-border p-3 lg:flex">
          <div className={`${bar} h-6 w-1/2`} />
          {[0, 1, 2, 3].map(i => (
            <div key={i} className={`${bar} h-12`} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function EditorLoadError({ onRetry }: { onRetry: () => void }) {
  const t = useT('builder');
  return (
    <div className="grid h-screen place-items-center bg-background p-6">
      <div
        role="alert"
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-center"
        data-testid="editor-load-error"
      >
        <AlertTriangle
          className="mx-auto h-6 w-6 text-destructive-ink"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <h2 className="mt-3 text-base font-semibold">{t('loadErrorTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('loadError')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('loadErrorHint')}</p>
        <Button size="sm" type="button" onClick={onRetry} className="mt-4 font-semibold">
          {t('retry')}
        </Button>
      </div>
    </div>
  );
}
