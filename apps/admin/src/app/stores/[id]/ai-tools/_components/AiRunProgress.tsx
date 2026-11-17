'use client';

import Link from 'next/link';
import { withNumerals } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { SparkleIcon } from '@/components/SparkleIcon';
import type { useT } from '../../../../../i18n/useT';

type TFn = ReturnType<typeof useT>;
type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunJob {
  id: string;
  kind: string;
  status: JobStatus;
  direction: 'to_ar' | 'to_en' | null;
  total: number;
  processed: number;
  filled: number;
  skipped: number;
  failed: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errors?: Array<{
    entityKind: string;
    entityId: string;
    entityName: string;
    field?: string;
    error: string;
  }> | null;
  filledProducts?: Array<{ id: string; name: string }> | null;
}

export const isTerminal = (s: string) => s === 'completed' || s === 'failed' || s === 'cancelled';

const KIND_KEYS: Record<string, string> = {
  seo: 'jobKind.seo',
  faq_aeo: 'jobKind.faqAeo',
  howto_aeo: 'jobKind.howtoAeo',
  meta_aeo: 'jobKind.metaAeo',
  product_faqs: 'jobKind.productFaqs',
  recommendations: 'jobKind.recommendations',
  llms_txt: 'jobKind.llmsTxt',
  citation_copy: 'jobKind.citationCopy',
  brand_facts: 'jobKind.brandFacts',
  description_balance: 'jobKind.descriptionBalance',
  description_revert: 'jobKind.descriptionRevert',
  category_assign: 'jobKind.categoryAssign',
  image_alt: 'jobKind.imageAlt',
  excerpt: 'jobKind.excerpt',
  product_tags: 'jobKind.productTags',
};

export function jobKindLabel(
  kind: string,
  direction: 'to_ar' | 'to_en' | null | undefined,
  t: TFn
): string {
  if (kind === 'translate') {
    return direction === 'to_en' ? t('jobKind.translateToEn') : t('jobKind.translateToAr');
  }
  const key = KIND_KEYS[kind];
  return key ? t(key) : kind;
}

export function StatusBadge({ status, t }: { status: string; t: TFn }) {
  const styles =
    status === 'completed'
      ? 'bg-success/15 text-success-ink'
      : status === 'failed'
        ? 'bg-destructive/15 text-destructive-ink'
        : status === 'running'
          ? 'bg-warning/10 text-warning-ink'
          : 'bg-muted text-muted-foreground';
  const label =
    status === 'queued' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled'
      ? t(`status.${status}`)
      : status;
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>
      {label}
    </span>
  );
}

const fmt = (n: number) => n.toLocaleString(undefined, withNumerals());

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'ok' | 'bad' | 'muted';
}) {
  const color =
    tone === 'ok'
      ? 'text-success-ink'
      : tone === 'bad'
        ? 'text-destructive-ink'
        : 'text-muted-foreground';
  return (
    <div className="rounded-lg bg-card px-3 py-2">
      <div className={`text-lg font-bold tabular-nums ${color}`}>{fmt(value)}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

interface Totals {
  processed: number;
  total: number;
  filled: number;
  skipped: number;
  failed: number;
}

/** The one-sentence outcome: what is happening, or what happened, in plain words. */
function Summary({
  status,
  totals,
  t,
  undoHint,
}: {
  status: string;
  totals: Totals;
  t: TFn;
  undoHint: boolean;
}) {
  if (status === 'queued' || status === 'running') {
    return <p className="text-sm text-muted-foreground">{t('progress.running')}</p>;
  }
  if (status === 'cancelled') {
    return <p className="text-sm text-muted-foreground">{t('progress.stopped')}</p>;
  }
  return (
    <div className="space-y-1">
      <p className="text-sm text-foreground">
        {status === 'failed'
          ? t('progress.failedSummary')
          : t('progress.doneSummary', {
              filled: fmt(totals.filled),
              skipped: fmt(totals.skipped),
              failed: fmt(totals.failed),
            })}
      </p>
      {status === 'completed' && (
        <p className="text-sm">
          <a href="#ai-results" className="font-medium text-primary-ink hover:underline">
            {t('progress.seeResults')}
          </a>
          {undoHint && (
            <>
              {' · '}
              <a
                href="#tool-revert-balance"
                className="font-medium text-primary-ink hover:underline"
              >
                {t('progress.undoHint')}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function Bar({ totals, label }: { totals: Totals; label: string }) {
  const pct =
    totals.total > 0 ? Math.min(100, Math.round((totals.processed / totals.total) * 100)) : 0;
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium tabular-nums">
          {fmt(totals.processed)} / {fmt(totals.total)}
        </span>
        <span className="tabular-nums text-muted-foreground">{fmt(pct)}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StatsRow({ totals, t }: { totals: Totals; t: TFn }) {
  return (
    <div className="grid grid-cols-3 gap-2 text-sm sm:gap-3">
      <Stat label={t('stats.filled')} value={totals.filled} tone="ok" />
      <Stat label={t('stats.skipped')} value={totals.skipped} tone="muted" />
      <Stat
        label={t('stats.failed')}
        value={totals.failed}
        tone={totals.failed > 0 ? 'bad' : 'muted'}
      />
    </div>
  );
}

const SHELL = 'rounded-xl border-2 border-primary/30 bg-primary/5 p-4 sm:p-5';

export function ActiveJobCard({
  job,
  storeId,
  cancelling,
  onCancel,
  onClose,
  t,
}: {
  job: RunJob;
  storeId: string;
  cancelling?: boolean;
  onCancel?: () => void;
  onClose: () => void;
  t: TFn;
}) {
  const done = isTerminal(job.status);
  const filledList = job.filledProducts ?? [];
  const title = jobKindLabel(job.kind, job.direction, t);
  const dateText = done
    ? job.completedAt
      ? t('activeJob.statusCompletedAt', {
          date: new Date(job.completedAt).toLocaleString(undefined, withNumerals()),
        })
      : null
    : job.startedAt
      ? t('activeJob.statusStartedAt', {
          date: new Date(job.startedAt).toLocaleString(undefined, withNumerals()),
        })
      : t('activeJob.statusQueued');
  return (
    <section className={SHELL} aria-label={title} data-testid="active-job">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            {title}
            <StatusBadge status={job.status} t={t} />
          </h3>
          {dateText && <p className="mt-0.5 text-xs text-muted-foreground">{dateText}</p>}
        </div>
        <div className="flex items-center gap-2">
          {!done && onCancel && (
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/40 text-destructive-ink"
              type="button"
              onClick={onCancel}
              disabled={cancelling}
            >
              {cancelling ? t('activeJob.cancelling') : t('activeJob.cancel')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            type="button"
            onClick={onClose}
          >
            {done ? t('activeJob.dismiss') : t('activeJob.hide')}
          </Button>
        </div>
      </div>

      <div role="status" aria-live="polite" className="mb-3">
        <Summary
          status={job.status}
          totals={job}
          t={t}
          undoHint={job.kind === 'description_balance'}
        />
      </div>
      <Bar totals={job} label={title} />
      <StatsRow totals={job} t={t} />

      {job.errorMessage && (
        <p role="alert" className="mt-3 text-sm text-destructive-ink">
          {job.errorMessage}
        </p>
      )}

      {filledList.length > 0 && (
        <details className="mt-3">
          <summary className="min-h-8 cursor-pointer py-1 text-sm font-medium text-success-ink">
            {t('activeJob.viewFilled', { count: filledList.length })}
          </summary>
          <ul className="mt-2 space-y-1 text-sm">
            {filledList.map(p => (
              <li key={p.id} className="rounded-md bg-card px-2 py-1.5">
                <Link
                  href={`/stores/${storeId}/products/${p.id}`}
                  className="font-medium text-foreground hover:text-primary-ink hover:underline"
                >
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}

      {job.errors && job.errors.length > 0 && (
        <details className="mt-3">
          <summary className="min-h-8 cursor-pointer py-1 text-sm font-medium text-muted-foreground">
            {t('activeJob.viewFailures', { count: job.errors.length })}
          </summary>
          <ul className="mt-2 space-y-1 text-sm">
            {job.errors.slice(0, 50).map((e, i) => (
              <li key={i} className="rounded-md bg-card px-2 py-1.5">
                <span className="font-medium">
                  {e.entityKind} · {e.entityName}
                </span>
                {e.field && <span className="text-muted-foreground"> · {e.field}</span>}
                <span className="ms-2 text-destructive-ink">{e.error}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function MasterSweepCard({
  label,
  jobs,
  onCancel,
  onClose,
  t,
}: {
  label: string;
  jobs: RunJob[];
  onCancel?: () => void;
  onClose: () => void;
  t: TFn;
}) {
  const totals = jobs.reduce<Totals>(
    (a, j) => ({
      processed: a.processed + j.processed,
      total: a.total + j.total,
      filled: a.filled + j.filled,
      skipped: a.skipped + j.skipped,
      failed: a.failed + j.failed,
    }),
    { processed: 0, total: 0, filled: 0, skipped: 0, failed: 0 }
  );
  const allDone = jobs.length > 0 && jobs.every(j => isTerminal(j.status));
  const anyActive = jobs.some(j => !isTerminal(j.status));
  const status: string = allDone
    ? jobs.some(j => j.status === 'failed')
      ? 'failed'
      : jobs.every(j => j.status === 'cancelled')
        ? 'cancelled'
        : 'completed'
    : jobs.some(j => j.status === 'running')
      ? 'running'
      : 'queued';
  return (
    <section className={SHELL} aria-label={label} data-testid="active-master">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold">
          {label}
          <StatusBadge status={status} t={t} />
        </h3>
        <div className="flex items-center gap-2">
          {anyActive && onCancel && (
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/40 text-destructive-ink"
              type="button"
              onClick={onCancel}
            >
              {t('activeJob.cancelAll')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            type="button"
            onClick={onClose}
          >
            {allDone ? t('activeJob.dismiss') : t('activeJob.hide')}
          </Button>
        </div>
      </div>
      <div role="status" aria-live="polite" className="mb-3">
        <Summary status={status} totals={totals} t={t} undoHint={false} />
      </div>
      <Bar totals={totals} label={label} />
      <StatsRow totals={totals} t={t} />
      <ul className="mt-3 flex flex-wrap gap-2">
        {jobs.map(j => (
          <li
            key={j.id}
            className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-xs"
          >
            <span className="font-medium">{jobKindLabel(j.kind, j.direction, t)}</span>
            <StatusBadge status={j.status} t={t} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RunsEmpty({ t }: { t: TFn }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <SparkleIcon className="text-primary-ink" />
      {t('recentRuns.empty')}
    </p>
  );
}
