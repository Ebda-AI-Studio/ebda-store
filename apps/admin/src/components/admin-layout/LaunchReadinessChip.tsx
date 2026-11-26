'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { SETUP_GUIDE_ITEMS, type SetupGuideState } from '@ebda/shared';
import { apiGet } from '../../lib/api';
import { useT } from '@/i18n/useT';
import { launchProgress } from './launch-progress';

/**
 * Ambient launch-readiness chip for the top bar. It reads the same /setup-guide state as the dashboard checklist,
 * shows "x of y steps" and then "x of 5 paid orders", opens the checklist in a popover and has NO dismiss: it
 * disappears only when the launch goal is reached. Any failure (no store in the route, 403) renders nothing.
 */
export function LaunchReadinessChip() {
  const params = useParams();
  const storeId = typeof params?.id === 'string' ? params.id : '';
  const t = useT('launchChip');
  const tGuide = useT('onboarding.setupGuide');
  const [guide, setGuide] = useState<SetupGuideState | null>(null);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    void apiGet<SetupGuideState>(`/api/v1/stores/${storeId}/setup-guide`).then(({ data }) => {
      if (!cancelled && data?.items) setGuide(data);
    });
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, close]);

  if (!storeId || !guide) return null;
  const p = launchProgress(guide);
  if (p.phase === 'done') return null;

  const label =
    p.phase === 'steps'
      ? t('stepsLabel', { done: p.done, total: p.total })
      : t('ordersLabel', { done: p.done, goal: p.total });
  const pct = Math.round((p.done / p.total) * 100);
  const r = 9;
  const c = 2 * Math.PI * r;

  return (
    <div ref={wrap} className="relative" data-testid="launch-chip" data-phase={p.phase}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('openAria', { label })}
        className="gap-2"
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="shrink-0 -rotate-90"
        >
          <circle cx="12" cy="12" r={r} fill="none" strokeWidth="3" className="stroke-muted" />
          <circle
            cx="12"
            cy="12"
            r={r}
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct / 100)}
            className="stroke-primary"
          />
        </svg>
        <span className="tabular-nums sm:hidden">
          {p.done}/{p.total}
        </span>
        <span className="hidden whitespace-nowrap sm:inline">{label}</span>
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label={p.phase === 'steps' ? t('stepsTitle') : t('ordersTitle', { goal: p.total })}
          className="fixed inset-x-4 top-16 z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-xl sm:absolute sm:inset-x-auto sm:end-0 sm:top-full sm:mt-2 sm:w-96"
        >
          <p className="text-sm font-semibold text-foreground">
            {p.phase === 'steps' ? t('stepsTitle') : t('ordersTitle', { goal: p.total })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {p.phase === 'steps' ? t('stepsHint') : t('ordersHint', { goal: p.total })}
          </p>
          {p.phase === 'steps' ? (
            <ul className="mt-3 divide-y divide-border">
              {guide.items.map(item => {
                const def = SETUP_GUIDE_ITEMS.find(d => d.key === item.key);
                const title = tGuide(`items.${item.key}.title` as Parameters<typeof tGuide>[0]);
                const href = `/stores/${storeId}/${def?.href ?? ''}`.replace(/\/$/, '');
                return (
                  <li
                    key={item.key}
                    data-key={item.key}
                    data-done={item.done}
                    className="flex items-center gap-3 py-2.5"
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                        item.done
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border text-transparent'
                      }`}
                    >
                      ✓
                    </span>
                    <span
                      className={`min-w-0 flex-1 text-sm ${item.done ? 'text-muted-foreground line-through' : 'text-foreground'}`}
                    >
                      {title}
                    </span>
                    {item.done ? (
                      <span className="sr-only">{t('done')}</span>
                    ) : (
                      <Link
                        href={href}
                        onClick={close}
                        className="inline-flex min-h-11 items-center text-xs font-medium text-primary underline"
                      >
                        {t('open')}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="mt-3">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={p.total}
                aria-valuenow={p.done}
                aria-label={label}
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
              <Link
                href={`/stores/${storeId}/orders`}
                onClick={close}
                className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-primary underline"
              >
                {t('viewOrders')}
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
