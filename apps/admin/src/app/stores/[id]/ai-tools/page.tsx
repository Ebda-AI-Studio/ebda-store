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
  kind:
    | 'translate'
    | 'seo'
    | 'faq_aeo'
    | 'howto_aeo'
    | 'meta_aeo'
    | 'recommendations'
    | 'llms_txt'
    | 'citation_copy'
    | 'brand_facts';
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

/** Three jobs launched by a master sweep button, tracked as a unit. */
interface MasterSweep {
  masterRunId: string;
  jobIds: string[];
  label: string;
  jobs: BulkAiJobDetail[];
}

// Poll cadence for active bulk-AI jobs. 4s is the sweet spot:
// - fast enough that progress feels live (UI ticks within 4s of each
//   batch persist)
// - slow enough to stay under the global 100 req / 15 min ip-keyed
//   rate limiter
const POLL_MS = 4000;

function jobKindLabel(kind: BulkAiJob['kind'], direction?: 'to_ar' | 'to_en' | null): string {
  switch (kind) {
    case 'translate':
      return `Translate (${direction === 'to_en' ? '→ EN' : '→ AR'})`;
    case 'seo':
      return 'SEO meta';
    case 'faq_aeo':
      return 'Draft FAQs';
    case 'howto_aeo':
      return 'Draft HowTos';
    case 'meta_aeo':
      return 'Meta AEO rewrite';
    case 'recommendations':
      return 'AI recommendations';
    case 'llms_txt':
      return 'LLMs.txt';
    case 'citation_copy':
      return 'Citation copy';
    case 'brand_facts':
      return 'Brand facts';
    default:
      return kind;
  }
}

export default function AiToolsPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [jobs, setJobs] = useState<BulkAiJob[]>([]);
  const [activeJob, setActiveJob] = useState<BulkAiJobDetail | null>(null);
  const [activeMaster, setActiveMaster] = useState<MasterSweep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<
    | 'translate-ar'
    | 'translate-en'
    | 'seo'
    | 'faq-aeo'
    | 'howto-aeo'
    | 'meta-aeo'
    | 'aeo-all'
    | 'recommendations'
    | 'llms-txt'
    | 'citation-copy'
    | 'brand-facts'
    | 'geo-all'
    | null
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

  const fetchMasterJobs = useCallback(
    async (sweep: MasterSweep) => {
      const results = await Promise.all(
        sweep.jobIds.map(id =>
          apiGet<{ job: BulkAiJobDetail }>(`/api/v1/stores/${storeId}/ai/bulk/${id}`).then(
            r => r.data?.job
          )
        )
      );
      const jobs = results.filter((j): j is BulkAiJobDetail => !!j);
      setActiveMaster(prev => (prev ? { ...prev, jobs } : null));
    },
    [storeId]
  );

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Active single-job polling
  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === 'completed' || activeJob.status === 'failed') return;

    const interval = setInterval(() => {
      fetchActiveJob(activeJob.id);
      fetchJobs();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [activeJob, fetchActiveJob, fetchJobs]);

  // Active master sweep polling
  useEffect(() => {
    if (!activeMaster) return;
    const allDone = activeMaster.jobs.every(j => j.status === 'completed' || j.status === 'failed');
    if (allDone && activeMaster.jobs.length === activeMaster.jobIds.length) return;

    const interval = setInterval(() => {
      fetchMasterJobs(activeMaster);
      fetchJobs();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [activeMaster, fetchMasterJobs, fetchJobs]);

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

  async function startAeoAll() {
    setError(null);
    setStarting('aeo-all');
    try {
      const { data, error: apiError } = await apiPost<{
        masterRunId: string;
        jobs: BulkAiJob[];
      }>(`/api/v1/stores/${storeId}/ai/bulk/aeo-sweep-all`, { count: 8 });
      if (apiError || !data) {
        setError(apiError?.message || 'Failed to start AEO sweep');
        return;
      }
      setActiveMaster({
        masterRunId: data.masterRunId,
        jobIds: data.jobs.map(j => j.id),
        label: 'Run all AEO sweeps',
        jobs: data.jobs.map(j => ({ ...j, errors: null })) as BulkAiJobDetail[],
      });
      await fetchJobs();
    } catch {
      setError('Network error');
    } finally {
      setStarting(null);
    }
  }

  async function startRecommendations() {
    setError(null);
    setStarting('recommendations');
    try {
      const { data, error: apiError } = await apiPost<{ job: BulkAiJob }>(
        `/api/v1/stores/${storeId}/ai/bulk/recommendations`,
        {}
      );
      if (apiError || !data) {
        setError(apiError?.message || 'Failed to start recommendations sweep');
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

  async function startLlmsTxt() {
    setError(null);
    setStarting('llms-txt');
    try {
      const { data, error: apiError } = await apiPost<{ job: BulkAiJob }>(
        `/api/v1/stores/${storeId}/ai/bulk/llms-txt`,
        {}
      );
      if (apiError || !data) {
        setError(apiError?.message || 'Failed to start LLMs.txt generation');
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

  async function startCitationCopy() {
    setError(null);
    setStarting('citation-copy');
    try {
      const { data, error: apiError } = await apiPost<{ job: BulkAiJob }>(
        `/api/v1/stores/${storeId}/ai/bulk/citation-copy`,
        {}
      );
      if (apiError || !data) {
        setError(apiError?.message || 'Failed to start citation copy sweep');
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

  async function startBrandFacts() {
    setError(null);
    setStarting('brand-facts');
    try {
      const { data, error: apiError } = await apiPost<{ job: BulkAiJob }>(
        `/api/v1/stores/${storeId}/ai/bulk/brand-facts`,
        {}
      );
      if (apiError || !data) {
        setError(apiError?.message || 'Failed to start brand facts sweep');
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

  async function startGeoAll() {
    setError(null);
    setStarting('geo-all');
    try {
      const { data, error: apiError } = await apiPost<{
        masterRunId: string;
        jobs: BulkAiJob[];
      }>(`/api/v1/stores/${storeId}/ai/bulk/geo-sweep-all`, {});
      if (apiError || !data) {
        setError(apiError?.message || 'Failed to start GEO sweep');
        return;
      }
      setActiveMaster({
        masterRunId: data.masterRunId,
        jobIds: data.jobs.map(j => j.id),
        label: 'Run all GEO sweeps',
        jobs: data.jobs.map(j => ({ ...j, errors: null })) as BulkAiJobDetail[],
      });
      await fetchJobs();
    } catch {
      setError('Network error');
    } finally {
      setStarting(null);
    }
  }

  const anyRunning =
    (!!activeJob && activeJob.status !== 'completed' && activeJob.status !== 'failed') ||
    (!!activeMaster &&
      activeMaster.jobs.some(j => j.status !== 'completed' && j.status !== 'failed'));

  return (
    <AdminLayout
      title="AI Tools"
      subtitle="Catalogue-wide translation, SEO, AEO, and GEO sweeps"
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

      {/* ── Translation ───────────────────────────────────────────── */}
      <SectionHeading title="Translation" />
      <div className="grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title="Fill missing Arabic"
          body="Walks every product, category, and the store row. Translates the English value into Arabic only when the Arabic field is empty."
          buttonLabel="Run sweep"
          loading={starting === 'translate-ar'}
          disabled={anyRunning}
          onClick={() => startTranslate('to_ar')}
        />
        <BulkActionCard
          title="Fill missing English"
          body="Reverse direction. For every Arabic-only field, fills the English side. Skips already-bilingual entities."
          buttonLabel="Run sweep"
          loading={starting === 'translate-en'}
          disabled={anyRunning}
          onClick={() => startTranslate('to_en')}
        />
      </div>

      {/* ── SEO ───────────────────────────────────────────────────── */}
      <SectionHeading title="SEO" className="mt-6" />
      <div className="grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title="Generate missing SEO meta"
          body="For the store row and every product, generates meta title + description in EN and AR when those fields are empty. Skips entities that already have SEO."
          buttonLabel="Run sweep"
          loading={starting === 'seo'}
          disabled={anyRunning}
          onClick={startSeo}
        />
        <BulkActionCard
          title="AI product recommendations"
          body='Generate AI-driven cross-sell recommendations across your catalogue. Fills the storefront "You might also like" section on each product page. Re-running updates existing suggestions.'
          buttonLabel="Run sweep"
          loading={starting === 'recommendations'}
          disabled={anyRunning}
          onClick={startRecommendations}
        />
      </div>

      {/* ── AEO ───────────────────────────────────────────────────── */}
      <SectionHeading title="AEO — Answer Engine Optimization" className="mt-6">
        <button
          type="button"
          onClick={startAeoAll}
          disabled={starting === 'aeo-all' || anyRunning}
          className="inline-flex items-center gap-2 rounded-lg bg-[#fc6b02] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting === 'aeo-all' ? (
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
          {starting === 'aeo-all' ? 'Starting…' : 'Run all AEO sweeps'}
        </button>
      </SectionHeading>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title="Draft FAQs with AI"
          body="Generates up to 8 store-level FAQ items covering delivery, payments, returns, product care, and more — bilingual (EN + AR). Skips questions a merchant has already edited."
          buttonLabel="Draft FAQs"
          loading={starting === 'faq-aeo'}
          disabled={anyRunning}
          onClick={startFaqAeo}
          resultsHref={`/stores/${storeId}/seo#faqs`}
          resultsLabel="View FAQs on SEO page"
        />
        <BulkActionCard
          title="Draft How-To Guides with AI"
          body="Drafts up to 3 step-by-step HowTo guides relevant to the store's product mix (e.g. how to place an order, how to return an item). Bilingual EN + AR."
          buttonLabel="Draft HowTos"
          loading={starting === 'howto-aeo'}
          disabled={anyRunning}
          onClick={startHowtoAeo}
          resultsHref={`/stores/${storeId}/seo#howtos`}
          resultsLabel="View HowTos on SEO page"
        />
        <BulkActionCard
          title="Rewrite Meta Descriptions (AEO)"
          body="Rewrites empty store, product, and category meta descriptions in a conversational, direct-answer style suited for AI answer engines. Only fills blank AEO fields — never overwrites existing content."
          buttonLabel="Rewrite meta"
          loading={starting === 'meta-aeo'}
          disabled={anyRunning}
          onClick={startMetaAeo}
          resultsHref={`/stores/${storeId}/seo`}
          resultsLabel="View meta on SEO page"
        />
      </div>

      {/* ── GEO ───────────────────────────────────────────────────── */}
      <SectionHeading title="GEO — Generative Engine Optimization" className="mt-6">
        <button
          type="button"
          onClick={startGeoAll}
          disabled={starting === 'geo-all' || anyRunning}
          className="inline-flex items-center gap-2 rounded-lg bg-[#fc6b02] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting === 'geo-all' ? (
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
          {starting === 'geo-all' ? 'Starting…' : 'Run all GEO sweeps'}
        </button>
      </SectionHeading>
      <p className="mt-1 text-xs text-muted-foreground">
        Optimises your store for LLM-powered search — ChatGPT, Perplexity, Google AI Overview, Bing
        Copilot.
      </p>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title="Generate LLMs.txt"
          body="Creates a /llms.txt file listing your store's categories, example product URLs, and key info. AI crawlers use this to understand your catalogue without scraping every page."
          buttonLabel="Generate"
          loading={starting === 'llms-txt'}
          disabled={anyRunning}
          onClick={startLlmsTxt}
        />
        <BulkActionCard
          title="Product citation copy"
          body='Rewrites product descriptions in "definitive first sentence + key specs" format — the exact style AI assistants quote when answering product questions. Fills empty products only.'
          buttonLabel="Run sweep"
          loading={starting === 'citation-copy'}
          disabled={anyRunning}
          onClick={startCitationCopy}
        />
        <BulkActionCard
          title="Brand facts JSON"
          body="Generates structured brand facts (location, categories, languages, contact methods) as a JSON-LD Organization block. Emitted on every storefront page to improve AI knowledge-graph entries."
          buttonLabel="Generate"
          loading={starting === 'brand-facts'}
          disabled={anyRunning}
          onClick={startBrandFacts}
        />
      </div>

      {/* Active single-job progress */}
      {activeJob && (
        <ActiveJobCard
          job={activeJob}
          onClose={() => {
            setActiveJob(null);
            fetchJobs();
          }}
        />
      )}

      {/* Active master sweep progress */}
      {activeMaster && (
        <MasterSweepCard
          sweep={activeMaster}
          onClose={() => {
            setActiveMaster(null);
            fetchJobs();
          }}
        />
      )}

      {/* Recent runs table */}
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
                    <td className="px-4 py-3 font-medium">{jobKindLabel(j.kind, j.direction)}</td>
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

// -----------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------

function SectionHeading({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 ${className ?? ''}`}>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {children}
    </div>
  );
}

function BulkActionCard({
  title,
  body,
  buttonLabel,
  loading,
  disabled,
  onClick,
  resultsHref,
  resultsLabel,
}: {
  title: string;
  body: string;
  buttonLabel: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
  resultsHref?: string;
  resultsLabel?: string;
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
      {resultsHref && (
        <Link
          href={resultsHref}
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {resultsLabel ?? 'View results'}
          <span aria-hidden>→</span>
        </Link>
      )}
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
          <h3 className="text-base font-semibold">{jobKindLabel(job.kind, job.direction)} sweep</h3>
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

function MasterSweepCard({ sweep, onClose }: { sweep: MasterSweep; onClose: () => void }) {
  const { jobs, label } = sweep;

  // Aggregate totals across all sub-jobs
  const totals = jobs.reduce(
    (acc, j) => ({
      processed: acc.processed + j.processed,
      total: acc.total + j.total,
      filled: acc.filled + j.filled,
      skipped: acc.skipped + j.skipped,
      failed: acc.failed + j.failed,
    }),
    { processed: 0, total: 0, filled: 0, skipped: 0, failed: 0 }
  );

  const allDone =
    jobs.length > 0 && jobs.every(j => j.status === 'completed' || j.status === 'failed');
  const anyFailed = jobs.some(j => j.status === 'failed');
  const pct =
    totals.total > 0 ? Math.min(100, Math.round((totals.processed / totals.total) * 100)) : 0;

  const overallStatus = allDone
    ? anyFailed
      ? 'failed'
      : 'completed'
    : jobs.some(j => j.status === 'running')
      ? 'running'
      : 'queued';

  return (
    <div className="mt-6 rounded-xl border-2 border-[#fc6b02]/30 bg-[#fc6b02]/5 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{label}</h3>
          <div className="mt-0.5 flex items-center gap-2">
            <StatusBadge status={overallStatus} />
            <span className="text-xs text-muted-foreground">
              {jobs.map(j => jobKindLabel(j.kind)).join(' + ')}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {allDone ? 'Dismiss' : 'Hide'}
        </button>
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-medium">
            {totals.processed} / {totals.total}
          </span>
          <span className="text-muted-foreground">{pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded bg-white/70">
          <div className="h-full bg-[#fc6b02] transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <Stat label="Filled" value={totals.filled} tone="ok" />
        <Stat label="Skipped" value={totals.skipped} tone="muted" />
        <Stat label="Failed" value={totals.failed} tone={totals.failed > 0 ? 'bad' : 'muted'} />
      </div>

      {/* Per-sub-job status chips */}
      <div className="mt-3 flex flex-wrap gap-2">
        {jobs.map(j => (
          <div
            key={j.id}
            className="flex items-center gap-1.5 rounded-full bg-white/60 px-3 py-1 text-xs"
          >
            <StatusBadge status={j.status} />
            <span className="font-medium">{jobKindLabel(j.kind)}</span>
          </div>
        ))}
      </div>
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
