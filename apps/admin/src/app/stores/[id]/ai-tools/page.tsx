'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost } from '../../../../lib/api';

/**
 * Bulk AI sweeps — kick off a catalogue-wide translation or SEO
 * fill, then poll for progress. Each merchant action turns into a
 * BulkAiJob row, processed by an Inngest function. The smart-skip
 * rule is enforced server-side: never overwrites filled fields,
 * never calls the model when both sides are already populated.
 *
 * Live behaviour:
 *   - Click a button → 202 + jobId returned instantly
 *   - This page polls /ai/bulk/:jobId every 1.5s while the job is
 *     queued or running
 *   - Status flips to completed → polling stops, summary stays on
 *     screen
 */

interface BulkAiJob {
  id: string;
  kind: 'translate' | 'seo' | 'faq_aeo' | 'howto_aeo' | 'meta_aeo';
  status: 'queued' | 'running' | 'completed' | 'failed';
  direction: 'to_ar' | 'to_en' | null;
  total: number;
  processed: number;
  filled: number;
  skipped: number;
  failed: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface BulkAiJobDetail extends BulkAiJob {
  errors: Array<{
    entityKind: string;
    entityId: string;
    entityName: string;
    field?: string;
    error: string;
  }> | null;
}

const POLL_MS = 1500;

export default function AiToolsPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [jobs, setJobs] = useState<BulkAiJob[]>([]);
  const [activeJob, setActiveJob] = useState<BulkAiJobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<
    'translate-ar' | 'translate-en' | 'seo' | 'faq-aeo' | 'howto-aeo' | 'meta-aeo' | null
  >(null);

  const fetchJobs = useCallback(async () => {
    if (!storeId) return;
    const { data } = await apiGet<{ jobs: BulkAiJob[] }>(`/api/v1/stores/${storeId}/ai/bulk`);
    if (data?.jobs) setJobs(data.jobs);
  }, [storeId]);

  const fetchActiveJob = useCallback(
    async (jobId: string) => {
      const { data } = await apiGet<{ job: BulkAiJobDetail }>(
        `/api/v1/stores/${storeId}/ai/bulk/${jobId}`
      );
      if (data?.job) setActiveJob(data.job);
    },
    [storeId]
  );

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Active-job polling — stop when terminal
  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === 'completed' || activeJob.status === 'failed') return;

    const interval = setInterval(() => {
      fetchActiveJob(activeJob.id);
      fetchJobs();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [activeJob, fetchActiveJob, fetchJobs]);

  async function startTranslate(direction: 'to_ar' | 'to_en') {
    setError(null);
    setStarting(direction === 'to_ar' ? 'translate-ar' : 'translate-en');
    try {
      const { data, error: apiError } = await apiPost<{ job: BulkAiJob }>(
        `/api/v1/stores/${storeId}/ai/bulk/translate`,
        { direction }
      );
      if (apiError || !data) {
        setError(apiError?.message || 'Failed to start sweep');
        return;
      }
      setActiveJob({ ...data.job, errors: null } as BulkAiJobDetail);
      await fetchJobs();
    } catch {
      setError('Network error');
    } finally {
      setStarting(null);
    }
  }

  async function startSeo() {
    setError(null);
    setStarting('seo');
    try {
      const { data, error: apiError } = await apiPost<{ job: BulkAiJob }>(
        `/api/v1/stores/${storeId}/ai/bulk/seo`,
        {}
      );
      if (apiError || !data) {
        setError(apiError?.message || 'Failed to start sweep');
        return;
      }
      setActiveJob({ ...data.job, errors: null } as BulkAiJobDetail);
      await fetchJobs();
    } catch {
      setError('Network error');
    } finally {
      setStarting(null);
    }
  }

  async function startFaqAeo() {
    setError(null);
    setStarting('faq-aeo');
    try {
      const { data, error: apiError } = await apiPost<{ job: BulkAiJob }>(
        `/api/v1/stores/${storeId}/ai/bulk/faq-aeo`,
        { count: 8 }
      );
      if (apiError || !data) {
        setError(apiError?.message || 'Failed to start FAQ draft');
        return;
      }
      setActiveJob({ ...data.job, errors: null } as BulkAiJobDetail);
      await fetchJobs();
    } catch {
      setError('Network error');
    } finally {
      setStarting(null);
    }
  }

  async function startHowtoAeo() {
    setError(null);
    setStarting('howto-aeo');
    try {
      const { data, error: apiError } = await apiPost<{ job: BulkAiJob }>(
        `/api/v1/stores/${storeId}/ai/bulk/howto-aeo`,
        { count: 3 }
      );
      if (apiError || !data) {
        setError(apiError?.message || 'Failed to start How-To draft');
        return;
      }
      setActiveJob({ ...data.job, errors: null } as BulkAiJobDetail);
      await fetchJobs();
    } catch {
      setError('Network error');
    } finally {
      setStarting(null);
    }
  }

  async function startMetaAeo() {
    setError(null);
    setStarting('meta-aeo');
    try {
      const { data, error: apiError } = await apiPost<{ job: BulkAiJob }>(
        `/api/v1/stores/${storeId}/ai/bulk/meta-aeo`,
        {}
      );
      if (apiError || !data) {
        setError(apiError?.message || 'Failed to start meta rewrite');
        return;
      }
      setActiveJob({ ...data.job, errors: null } as BulkAiJobDetail);
      await fetchJobs();
    } catch {
      setError('Network error');
    } finally {
      setStarting(null);
    }
  }

  return (
    <AdminLayout
      title="AI Tools"
      subtitle="Catalogue-wide translation, SEO, and AEO sweeps"
      actions={
        <Link href={`/stores/${storeId}`}>
          <Button type="button" variant="outline">
            Back to store
          </Button>
        </Link>
      }
    >
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title="Fill missing Arabic"
          body="Walks every product, category, and the store row. Translates the English value into Arabic only when the Arabic field is empty."
          buttonLabel="Run sweep"
          loading={starting === 'translate-ar'}
          disabled={
            !!activeJob && activeJob.status !== 'completed' && activeJob.status !== 'failed'
          }
          onClick={() => startTranslate('to_ar')}
        />
        <BulkActionCard
          title="Fill missing English"
          body="Reverse direction. For every Arabic-only field, fills the English side. Skips already-bilingual entities."
          buttonLabel="Run sweep"
          loading={starting === 'translate-en'}
          disabled={
            !!activeJob && activeJob.status !== 'completed' && activeJob.status !== 'failed'
          }
          onClick={() => startTranslate('to_en')}
        />
        <BulkActionCard
          title="Generate missing SEO meta"
          body="For the store row and every product, generates meta title + description in EN and AR when those fields are empty. Skips entities that already have SEO."
          buttonLabel="Run sweep"
          loading={starting === 'seo'}
          disabled={
            !!activeJob && activeJob.status !== 'completed' && activeJob.status !== 'failed'
          }
          onClick={startSeo}
        />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title="Draft FAQs with AI"
          body="Generates up to 8 store-level FAQ items covering delivery, payments, returns, product care, and more — bilingual (EN + AR). Skips questions a merchant has already edited."
          buttonLabel="Draft FAQs"
          loading={starting === 'faq-aeo'}
          disabled={
            !!activeJob && activeJob.status !== 'completed' && activeJob.status !== 'failed'
          }
          onClick={startFaqAeo}
        />
        <BulkActionCard
          title="Draft How-To Guides with AI"
          body="Drafts up to 3 step-by-step HowTo guides relevant to the store's product mix (e.g. how to place an order, how to return an item). Bilingual EN + AR."
          buttonLabel="Draft HowTos"
          loading={starting === 'howto-aeo'}
          disabled={
            !!activeJob && activeJob.status !== 'completed' && activeJob.status !== 'failed'
          }
          onClick={startHowtoAeo}
        />
        <BulkActionCard
          title="Rewrite Meta Descriptions (AEO)"
          body="Rewrites empty store and product meta descriptions in a conversational, direct-answer style suited for AI answer engines. Only fills blank fields — never overwrites existing content."
          buttonLabel="Rewrite meta"
          loading={starting === 'meta-aeo'}
          disabled={
            !!activeJob && activeJob.status !== 'completed' && activeJob.status !== 'failed'
          }
          onClick={startMetaAeo}
        />
      </div>

      {activeJob && (
        <ActiveJobCard
          job={activeJob}
          onClose={() => {
            setActiveJob(null);
            fetchJobs();
          }}
        />
      )}

      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Recent runs</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sweeps yet.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-start">Started</th>
                  <th className="px-4 py-3 text-start">Kind</th>
                  <th className="px-4 py-3 text-start">Status</th>
                  <th className="px-4 py-3 text-end">Filled</th>
                  <th className="px-4 py-3 text-end">Skipped</th>
                  <th className="px-4 py-3 text-end">Failed</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {jobs.map(j => (
                  <tr key={j.id} className="border-t">
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(j.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {j.kind === 'translate'
                        ? `Translate (${j.direction === 'to_en' ? '→ EN' : '→ AR'})`
                        : j.kind === 'seo'
                          ? 'SEO meta'
                          : j.kind === 'faq_aeo'
                            ? 'Draft FAQs'
                            : j.kind === 'howto_aeo'
                              ? 'Draft HowTos'
                              : 'Meta AEO rewrite'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="px-4 py-3 text-end font-medium text-emerald-600">{j.filled}</td>
                    <td className="px-4 py-3 text-end text-muted-foreground">{j.skipped}</td>
                    <td className="px-4 py-3 text-end font-medium text-destructive">{j.failed}</td>
                    <td className="px-4 py-3 text-end">
                      <button
                        type="button"
                        onClick={() => fetchActiveJob(j.id).then(() => undefined)}
                        className="text-xs text-primary hover:underline"
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}

function BulkActionCard({
  title,
  body,
  buttonLabel,
  loading,
  disabled,
  onClick,
}: {
  title: string;
  body: string;
  buttonLabel: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <h3 className="mb-2 text-base font-semibold">{title}</h3>
      <p className="mb-4 text-sm text-muted-foreground">{body}</p>
      <button
        type="button"
        onClick={onClick}
        disabled={loading || disabled}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#fc6b02] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? (
          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : (
          <span aria-hidden>✨</span>
        )}
        <span>{loading ? 'Starting…' : buttonLabel}</span>
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles =
    status === 'completed'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'failed'
        ? 'bg-destructive/15 text-destructive'
        : status === 'running'
          ? 'bg-amber-100 text-amber-700'
          : 'bg-muted text-foreground';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>
      {status}
    </span>
  );
}

function ActiveJobCard({ job, onClose }: { job: BulkAiJobDetail; onClose: () => void }) {
  const pct = job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;
  const isDone = job.status === 'completed' || job.status === 'failed';

  return (
    <div className="mt-6 rounded-xl border-2 border-[#fc6b02]/30 bg-[#fc6b02]/5 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            {job.kind === 'translate'
              ? `Translation sweep (${job.direction === 'to_en' ? '→ EN' : '→ AR'})`
              : job.kind === 'seo'
                ? 'SEO meta sweep'
                : job.kind === 'faq_aeo'
                  ? 'FAQ draft sweep'
                  : job.kind === 'howto_aeo'
                    ? 'HowTo draft sweep'
                    : 'Meta AEO rewrite sweep'}
          </h3>
          <p className="text-xs text-muted-foreground">
            {isDone
              ? job.completedAt
                ? `Completed ${new Date(job.completedAt).toLocaleString()}`
                : 'Completed'
              : job.startedAt
                ? `Started ${new Date(job.startedAt).toLocaleString()}`
                : 'Queued'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {isDone ? 'Dismiss' : 'Hide'}
        </button>
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-medium">
            {job.processed} / {job.total}
          </span>
          <span className="text-muted-foreground">{pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded bg-white/70">
          <div className="h-full bg-[#fc6b02] transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <Stat label="Filled" value={job.filled} tone="ok" />
        <Stat label="Skipped" value={job.skipped} tone="muted" />
        <Stat label="Failed" value={job.failed} tone={job.failed > 0 ? 'bad' : 'muted'} />
      </div>

      {job.errorMessage && <p className="mt-3 text-sm text-destructive">{job.errorMessage}</p>}

      {job.errors && job.errors.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            View {job.errors.length} failure{job.errors.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {job.errors.slice(0, 50).map((e, i) => (
              <li key={i} className="rounded bg-white px-2 py-1.5">
                <span className="font-medium">
                  {e.entityKind} · {e.entityName}
                </span>
                {e.field && <span className="text-muted-foreground"> · {e.field}</span>}
                <span className="ms-2 text-destructive">{e.error}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

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
      ? 'text-emerald-700'
      : tone === 'bad'
        ? 'text-destructive'
        : 'text-muted-foreground';
  return (
    <div className="rounded-lg bg-white px-3 py-2">
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
