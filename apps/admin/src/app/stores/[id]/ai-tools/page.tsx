'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@ebda/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost } from '../../../../lib/api';
import { GeoResultsPanel } from './_components/GeoResultsPanel';
import { AiSweepResultsPanels } from './_components/AiSweepResultsPanels';
import { AiUsageSummaryCard } from '../../../../components/ai/AiUsageSummaryCard';
import { AiSwitchCard } from '../../../../components/ai/AiSwitchCard';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { useT } from '../../../../i18n/useT';
import { DataTable, type DataTableColumn } from '../../../../components/mobile/DataTable';
import { withNumerals } from '@ebda/shared';

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
    | 'product_faqs'
    | 'recommendations'
    | 'llms_txt'
    | 'citation_copy'
    | 'brand_facts'
    | 'description_balance'
    | 'description_revert'
    | 'category_assign'
    | 'image_alt'
    | 'excerpt'
    | 'product_tags';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
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
  // Products this job actually filled — surfaced so the merchant can open each
  // and validate the AI-written content. Populated by description-balance today;
  // other fill jobs may adopt it later (null/absent = not tracked for that kind).
  filledProducts?: Array<{ id: string; name: string }> | null;
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

export default function AiToolsPage() {
  const t = useT('aiTools');
  // Feature gate: bulk_operations covers AI catalogue sweeps; absent from
  // PLAN_BASELINE by default and enabled via super-admin override per store.
  const { gate } = useRequireFeature('bulk_operations', {
    pageTitle: t('title'),
  });

  const params = useParams();
  const storeId = params?.id as string;

  const [jobs, setJobs] = useState<BulkAiJob[]>([]);
  const [activeJob, setActiveJob] = useState<BulkAiJobDetail | null>(null);
  const [activeMaster, setActiveMaster] = useState<MasterSweep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<
    | 'translate-ar'
    | 'translate-en'
    | 'balance-descriptions'
    | 'revert-balance'
    | 'seo'
    | 'faq-aeo'
    | 'howto-aeo'
    | 'meta-aeo'
    | 'product-faqs'
    | 'aeo-all'
    | 'recommendations'
    | 'llms-txt'
    | 'citation-copy'
    | 'brand-facts'
    | 'geo-all'
    | 'categorize'
    | 'image-alt'
    | 'excerpt'
    | 'tags'
    | null
  >(null);
  const [cancelling, setCancelling] = useState<string | null>(null); // jobId being cancelled

  // Master sweep "replace existing" checkbox states
  const [aeoForce, setAeoForce] = useState(false);
  const [geoForce, setGeoForce] = useState(false);

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
    if (isTerminal(activeJob.status)) return;

    const interval = setInterval(() => {
      fetchActiveJob(activeJob.id);
      fetchJobs();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [activeJob, fetchActiveJob, fetchJobs]);

  // Active master sweep polling
  useEffect(() => {
    if (!activeMaster) return;
    const allDone = activeMaster.jobs.every(j => isTerminal(j.status));
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
        setError(apiError?.message || t('errorFailedToStart'));
        return;
      }
      setActiveJob({ ...data.job, errors: null } as BulkAiJobDetail);
      await fetchJobs();
    } catch {
      setError(t('errorNetwork'));
    } finally {
      setStarting(null);
    }
  }

  type StartingKey = NonNullable<typeof starting>;

  /** Shared single-job starter. Handles smart-skip (default) and force paths. */
  async function start(endpoint: string, key: StartingKey, body: object = {}, force = false) {
    if (force) {
      if (!confirm(t('confirmReplace'))) return;
    }
    setError(null);
    setStarting(key);
    try {
      const isMaster = endpoint.includes('sweep-all');
      const payload = force ? { force: true, ...body } : { ...body };
      if (isMaster) {
        const { data, error: apiError } = await apiPost<{ masterRunId: string; jobs: BulkAiJob[] }>(
          `/api/v1/stores/${storeId}/ai${endpoint}`,
          payload
        );
        if (apiError || !data) {
          setError(apiError?.message || t('errorFailed'));
          return;
        }
        setActiveMaster({
          masterRunId: data.masterRunId,
          jobIds: data.jobs.map(j => j.id),
          label: endpoint.includes('aeo') ? t('masterSweep.runAllAeo') : t('masterSweep.runAllGeo'),
          jobs: data.jobs.map(j => ({ ...j, errors: null })) as BulkAiJobDetail[],
        });
      } else {
        const { data, error: apiError } = await apiPost<{ job: BulkAiJob }>(
          `/api/v1/stores/${storeId}/ai${endpoint}`,
          payload
        );
        if (apiError || !data) {
          setError(apiError?.message || t('errorFailed'));
          return;
        }
        setActiveJob({ ...data.job, errors: null } as BulkAiJobDetail);
      }
      await fetchJobs();
    } catch {
      setError(t('errorNetwork'));
    } finally {
      setStarting(null);
    }
  }

  const isTerminal = (s: string) => s === 'completed' || s === 'failed' || s === 'cancelled';
  const anyRunning =
    (!!activeJob && !isTerminal(activeJob.status)) ||
    (!!activeMaster && activeMaster.jobs.some(j => !isTerminal(j.status)));

  async function cancelJob(jobId: string) {
    if (!confirm(t('confirmCancel'))) return;
    setCancelling(jobId);
    try {
      await apiPost(`/api/v1/stores/${storeId}/ai/jobs/${jobId}/cancel`, {});
      // Re-fetch immediately so the UI reflects cancelled state.
      await fetchActiveJob(jobId);
      await fetchJobs();
    } catch {
      // Ignore — progress poll will pick up the cancelled state.
    } finally {
      setCancelling(null);
    }
  }

  async function cancelMasterSweep(sweep: MasterSweep) {
    if (!confirm(t('confirmCancel'))) return;
    // Cancel all child jobs in parallel.
    await Promise.allSettled(
      sweep.jobIds.map(id => apiPost(`/api/v1/stores/${storeId}/ai/jobs/${id}/cancel`, {}))
    );
    await fetchMasterJobs(sweep);
    await fetchJobs();
  }

  const recentRunsColumns: DataTableColumn<BulkAiJob>[] = [
    {
      header: t('recentRuns.colStarted'),
      primaryOnMobile: true,
      cell: j => (
        <span className="text-muted-foreground">
          {new Date(j.createdAt).toLocaleString(undefined, withNumerals())}
        </span>
      ),
    },
    {
      header: t('recentRuns.colKind'),
      cell: j => <span className="font-medium">{jobKindLabel(j.kind, j.direction, t)}</span>,
    },
    {
      header: t('recentRuns.colStatus'),
      mobileBadge: true,
      cell: j => <StatusBadge status={j.status} t={t} />,
    },
    {
      header: t('recentRuns.colFilled'),
      alignEnd: true,
      cell: j => <span className="font-medium text-emerald-600">{j.filled}</span>,
    },
    {
      header: t('recentRuns.colSkipped'),
      alignEnd: true,
      hideOnMobile: true,
      cell: j => <span className="text-muted-foreground">{j.skipped}</span>,
    },
    {
      header: t('recentRuns.colFailed'),
      alignEnd: true,
      cell: j => <span className="font-medium text-destructive-ink">{j.failed}</span>,
    },
    {
      header: '',
      alignEnd: true,
      mobileActions: true,
      cell: j => (
        <button
          type="button"
          onClick={() => fetchActiveJob(j.id).then(() => undefined)}
          className="text-xs text-primary hover:underline"
        >
          {t('recentRuns.details')}
        </button>
      ),
    },
  ];

  // Render gate (upsell page) for store_admin when feature is disabled.
  // Super-admin always passes through so they can configure the feature.
  if (gate) return gate;

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <Link href={`/stores/${storeId}`}>
          <Button type="button" variant="outline">
            {t('backToStore')}
          </Button>
        </Link>
      }
    >
      <div className="mb-4">
        <AiSwitchCard storeId={storeId} />
      </div>

      {/* ── AI quota summary — visible before any sweep button ────── */}
      <div className="mb-6">
        <AiUsageSummaryCard storeId={storeId} embedded={true} />
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive-ink">
          {error}
        </div>
      )}

      {/* ── Translation ───────────────────────────────────────────── */}
      <SectionHeading title={t('sections.translation')} />
      <div className="grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title={t('cards.fillMissingArabic.title')}
          body={t('cards.fillMissingArabic.body')}
          buttonLabel={t('cards.fillMissingArabic.button')}
          startingLabel={t('starting')}
          loading={starting === 'translate-ar'}
          disabled={anyRunning}
          onAction={() => startTranslate('to_ar')}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.defaultForceTooltip')}
        />
        <BulkActionCard
          title={t('cards.fillMissingEnglish.title')}
          body={t('cards.fillMissingEnglish.body')}
          buttonLabel={t('cards.fillMissingEnglish.button')}
          startingLabel={t('starting')}
          loading={starting === 'translate-en'}
          disabled={anyRunning}
          onAction={() => startTranslate('to_en')}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.defaultForceTooltip')}
        />
      </div>

      {/* ── Description language balance ──────────────────────────── */}
      <SectionHeading title={t('sections.descriptionBalance')} className="mt-6" />
      <div className="grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title={t('cards.balanceDescriptions.title')}
          body={t('cards.balanceDescriptions.body')}
          buttonLabel={t('cards.balanceDescriptions.button')}
          startingLabel={t('starting')}
          loading={starting === 'balance-descriptions'}
          disabled={anyRunning}
          onAction={force => start('/bulk/balance-descriptions', 'balance-descriptions', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.balanceDescriptions.forceTooltip')}
        />
        <BulkActionCard
          title={t('cards.revertBalance.title')}
          body={t('cards.revertBalance.body')}
          buttonLabel={t('cards.revertBalance.button')}
          startingLabel={t('starting')}
          loading={starting === 'revert-balance'}
          disabled={anyRunning}
          onAction={force => start('/bulk/revert-balance', 'revert-balance', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.revertBalance.forceTooltip')}
        />
      </div>

      {/* ── SEO ───────────────────────────────────────────────────── */}
      <SectionHeading title={t('sections.seo')} className="mt-6" />
      <div className="grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title={t('cards.seoMeta.title')}
          body={t('cards.seoMeta.body')}
          buttonLabel={t('cards.seoMeta.button')}
          startingLabel={t('starting')}
          loading={starting === 'seo'}
          disabled={anyRunning}
          onAction={force => start('/bulk/seo', 'seo', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.seoMeta.forceTooltip')}
        />
        <BulkActionCard
          title={t('cards.recommendations.title')}
          body={t('cards.recommendations.body')}
          buttonLabel={t('cards.recommendations.button')}
          startingLabel={t('starting')}
          loading={starting === 'recommendations'}
          disabled={anyRunning}
          onAction={force => start('/bulk/recommendations', 'recommendations', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.recommendations.forceTooltip')}
        />
      </div>

      {/* ── AEO ───────────────────────────────────────────────────── */}
      <SectionHeading title={t('sections.aeo')} className="mt-6">
        <div className="flex items-center gap-3">
          <ReplaceCheckbox
            id="aeo-force"
            checked={aeoForce}
            onChange={setAeoForce}
            label={t('replaceExisting')}
            tooltip={t('masterSweep.aeoForceTooltip')}
          />
          <MasterSweepButton
            label={t('masterSweep.runAllAeo')}
            startingLabel={t('starting')}
            loading={starting === 'aeo-all'}
            disabled={anyRunning}
            onClick={() => start('/bulk/aeo-sweep-all', 'aeo-all', { count: 8 }, aeoForce)}
          />
        </div>
      </SectionHeading>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title={t('cards.draftFaqs.title')}
          body={t('cards.draftFaqs.body')}
          buttonLabel={t('cards.draftFaqs.button')}
          startingLabel={t('starting')}
          loading={starting === 'faq-aeo'}
          disabled={anyRunning}
          onAction={force => start('/bulk/faq-aeo', 'faq-aeo', { count: 8 }, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.draftFaqs.forceTooltip')}
          resultsHref={`/stores/${storeId}/seo#faqs`}
          resultsLabel={t('cards.draftFaqs.resultsLabel')}
        />
        <BulkActionCard
          title={t('cards.draftHowtos.title')}
          body={t('cards.draftHowtos.body')}
          buttonLabel={t('cards.draftHowtos.button')}
          startingLabel={t('starting')}
          loading={starting === 'howto-aeo'}
          disabled={anyRunning}
          onAction={force => start('/bulk/howto-aeo', 'howto-aeo', { count: 3 }, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.draftHowtos.forceTooltip')}
          resultsHref={`/stores/${storeId}/seo#howtos`}
          resultsLabel={t('cards.draftHowtos.resultsLabel')}
        />
        <BulkActionCard
          title={t('cards.metaAeo.title')}
          body={t('cards.metaAeo.body')}
          buttonLabel={t('cards.metaAeo.button')}
          startingLabel={t('starting')}
          loading={starting === 'meta-aeo'}
          disabled={anyRunning}
          onAction={force => start('/bulk/meta-aeo', 'meta-aeo', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.metaAeo.forceTooltip')}
          resultsHref={`/stores/${storeId}/seo`}
          resultsLabel={t('cards.metaAeo.resultsLabel')}
        />
        <BulkActionCard
          title={t('cards.productFaqs.title')}
          body={t('cards.productFaqs.body')}
          buttonLabel={t('cards.productFaqs.button')}
          startingLabel={t('starting')}
          loading={starting === 'product-faqs'}
          disabled={anyRunning}
          onAction={force => start('/bulk/product-faqs', 'product-faqs', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.productFaqs.forceTooltip')}
        />
      </div>

      {/* ── GEO ───────────────────────────────────────────────────── */}
      <SectionHeading title={t('sections.geo')} className="mt-6">
        <div className="flex items-center gap-3">
          <ReplaceCheckbox
            id="geo-force"
            checked={geoForce}
            onChange={setGeoForce}
            label={t('replaceExisting')}
            tooltip={t('masterSweep.geoForceTooltip')}
          />
          <MasterSweepButton
            label={t('masterSweep.runAllGeo')}
            startingLabel={t('starting')}
            loading={starting === 'geo-all'}
            disabled={anyRunning}
            onClick={() => start('/bulk/geo-sweep-all', 'geo-all', {}, geoForce)}
          />
        </div>
      </SectionHeading>
      <p className="mt-1 text-xs text-muted-foreground">{t('sections.geoDescription')}</p>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title={t('cards.llmsTxt.title')}
          body={t('cards.llmsTxt.body')}
          buttonLabel={t('cards.llmsTxt.button')}
          startingLabel={t('starting')}
          loading={starting === 'llms-txt'}
          disabled={anyRunning}
          onAction={force => start('/bulk/llms-txt', 'llms-txt', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.llmsTxt.forceTooltip')}
        />
        <BulkActionCard
          title={t('cards.citationCopy.title')}
          body={t('cards.citationCopy.body')}
          buttonLabel={t('cards.citationCopy.button')}
          startingLabel={t('starting')}
          loading={starting === 'citation-copy'}
          disabled={anyRunning}
          onAction={force => start('/bulk/citation-copy', 'citation-copy', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.citationCopy.forceTooltip')}
        />
        <BulkActionCard
          title={t('cards.brandFacts.title')}
          body={t('cards.brandFacts.body')}
          buttonLabel={t('cards.brandFacts.button')}
          startingLabel={t('starting')}
          loading={starting === 'brand-facts'}
          disabled={anyRunning}
          onAction={force => start('/bulk/brand-facts', 'brand-facts', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.brandFacts.forceTooltip')}
        />
      </div>

      {/* ── Catalogue field sweeps ────────────────────────────────── */}
      <SectionHeading title={t('sections.catalogueFields')} className="mt-6" />
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <BulkActionCard
          title={t('cards.categorize.title')}
          body={t('cards.categorize.body')}
          buttonLabel={t('cards.categorize.button')}
          startingLabel={t('starting')}
          loading={starting === 'categorize'}
          disabled={anyRunning}
          onAction={force => start('/bulk/categorize', 'categorize', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.categorize.forceTooltip')}
        />
        <BulkActionCard
          title={t('cards.imageAlt.title')}
          body={t('cards.imageAlt.body')}
          buttonLabel={t('cards.imageAlt.button')}
          startingLabel={t('starting')}
          loading={starting === 'image-alt'}
          disabled={anyRunning}
          onAction={force => start('/bulk/image-alt', 'image-alt', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.imageAlt.forceTooltip')}
        />
        <BulkActionCard
          title={t('cards.excerpt.title')}
          body={t('cards.excerpt.body')}
          buttonLabel={t('cards.excerpt.button')}
          startingLabel={t('starting')}
          loading={starting === 'excerpt'}
          disabled={anyRunning}
          onAction={force => start('/bulk/excerpt', 'excerpt', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.excerpt.forceTooltip')}
        />
        <BulkActionCard
          title={t('cards.productTags.title')}
          body={t('cards.productTags.body')}
          buttonLabel={t('cards.productTags.button')}
          startingLabel={t('starting')}
          loading={starting === 'tags'}
          disabled={anyRunning}
          onAction={force => start('/bulk/tags', 'tags', {}, force)}
          replaceExistingLabel={t('replaceExisting')}
          forceTooltip={t('cards.productTags.forceTooltip')}
        />
      </div>

      {/* Currently populated GEO outputs — closes the every-data-has-a-UI gap. */}
      <GeoResultsPanel storeId={storeId} refreshTrigger={jobs.length} />

      {/* Active single-job progress */}
      {activeJob && (
        <ActiveJobCard
          job={activeJob}
          cancelling={cancelling === activeJob.id}
          onCancel={() => cancelJob(activeJob.id)}
          onClose={() => {
            setActiveJob(null);
            fetchJobs();
          }}
          t={t}
        />
      )}

      {/* Active master sweep progress */}
      {activeMaster && (
        <MasterSweepCard
          sweep={activeMaster}
          onCancel={() => cancelMasterSweep(activeMaster)}
          onClose={() => {
            setActiveMaster(null);
            fetchJobs();
          }}
          t={t}
        />
      )}

      {/* Sweep result viewers (read-only panels for translate / seo / faqs / howtos / meta-aeo) */}
      <AiSweepResultsPanels storeId={storeId} />

      {/* Recent runs table */}
      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">{t('recentRuns.title')}</h2>
        <DataTable<BulkAiJob>
          ariaLabel={t('recentRuns.title')}
          columns={recentRunsColumns}
          rows={jobs}
          rowKey={j => j.id}
          emptyState={<p className="text-sm text-muted-foreground">{t('recentRuns.empty')}</p>}
        />
      </div>
    </AdminLayout>
  );
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

type TFn = ReturnType<typeof useT>;

function jobKindLabel(
  kind: BulkAiJob['kind'],
  direction: 'to_ar' | 'to_en' | null | undefined,
  t: TFn
): string {
  switch (kind) {
    case 'translate':
      return direction === 'to_en' ? t('jobKind.translateToEn') : t('jobKind.translateToAr');
    case 'seo':
      return t('jobKind.seo');
    case 'faq_aeo':
      return t('jobKind.faqAeo');
    case 'howto_aeo':
      return t('jobKind.howtoAeo');
    case 'meta_aeo':
      return t('jobKind.metaAeo');
    case 'product_faqs':
      return t('jobKind.productFaqs');
    case 'recommendations':
      return t('jobKind.recommendations');
    case 'llms_txt':
      return t('jobKind.llmsTxt');
    case 'citation_copy':
      return t('jobKind.citationCopy');
    case 'brand_facts':
      return t('jobKind.brandFacts');
    case 'description_balance':
      return t('jobKind.descriptionBalance');
    case 'description_revert':
      return t('jobKind.descriptionRevert');
    case 'category_assign':
      return t('jobKind.categoryAssign');
    case 'image_alt':
      return t('jobKind.imageAlt');
    case 'excerpt':
      return t('jobKind.excerpt');
    case 'product_tags':
      return t('jobKind.productTags');
    default:
      return kind;
  }
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

/** Small inline checkbox used by both master-sweep areas and individual cards. */
function ReplaceCheckbox({
  id,
  checked,
  onChange,
  label,
  tooltip,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  tooltip: string;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-1.5 select-none">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer accent-primary"
      />
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        title={tooltip}
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground"
        aria-label={tooltip}
      >
        {/* i18n-gate-allow: info glyph, not copy */}i
      </span>
    </label>
  );
}

function BulkActionCard({
  title,
  body,
  buttonLabel,
  startingLabel,
  loading,
  disabled,
  onAction,
  replaceExistingLabel,
  forceTooltip,
  resultsHref,
  resultsLabel,
}: {
  title: string;
  body: string;
  buttonLabel: string;
  startingLabel: string;
  loading: boolean;
  disabled: boolean;
  /** Called with force=true when checkbox is checked (after confirm), false otherwise. */
  onAction: (force: boolean) => void;
  replaceExistingLabel: string;
  forceTooltip: string;
  resultsHref?: string;
  resultsLabel?: string;
}) {
  const [replaceExisting, setReplaceExisting] = useState(false);

  const SpinIcon = () => (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );

  // Generate a stable id for the checkbox based on the card title
  const checkboxId = `replace-${title
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')}`;

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <h3 className="mb-2 text-base font-semibold">{title}</h3>
      <p className="mb-3 text-sm text-muted-foreground">{body}</p>

      <div className="mb-4">
        <ReplaceCheckbox
          id={checkboxId}
          checked={replaceExisting}
          onChange={setReplaceExisting}
          label={replaceExistingLabel}
          tooltip={forceTooltip}
        />
      </div>

      <button
        type="button"
        onClick={() => onAction(replaceExisting)}
        disabled={loading || disabled}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? <SpinIcon /> : <span aria-hidden>✨</span>}
        <span>{loading ? startingLabel : buttonLabel}</span>
      </button>

      {resultsHref && (
        <Link
          href={resultsHref}
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {resultsLabel}
          <span aria-hidden>→</span>
        </Link>
      )}
    </div>
  );
}

function MasterSweepButton({
  label,
  startingLabel,
  loading,
  disabled,
  onClick,
}: {
  label: string;
  startingLabel: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const SpinIcon = () => (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading || disabled}
      className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? <SpinIcon /> : <span aria-hidden>✨</span>}
      {loading ? startingLabel : label}
    </button>
  );
}

function StatusBadge({ status, t }: { status: string; t: TFn }) {
  const styles =
    status === 'completed'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'failed'
        ? 'bg-destructive/15 text-destructive-ink'
        : status === 'cancelled'
          ? 'bg-muted text-muted-foreground'
          : status === 'running'
            ? 'bg-amber-100 text-amber-700'
            : 'bg-muted text-foreground';

  const label = (() => {
    switch (status) {
      case 'queued':
        return t('status.queued');
      case 'running':
        return t('status.running');
      case 'completed':
        return t('status.completed');
      case 'failed':
        return t('status.failed');
      case 'cancelled':
        return t('status.cancelled');
      default:
        return status;
    }
  })();

  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>
      {label}
    </span>
  );
}

function ActiveJobCard({
  job,
  cancelling,
  onCancel,
  onClose,
  t,
}: {
  job: BulkAiJobDetail;
  cancelling?: boolean;
  onCancel?: () => void;
  onClose: () => void;
  t: TFn;
}) {
  const params = useParams();
  const storeId = String(params?.id ?? '');
  const pct = job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;
  const isDone =
    job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
  const isActive = job.status === 'running' || job.status === 'queued';
  const filledList = job.filledProducts ?? [];

  const statusText = (() => {
    if (job.status === 'cancelled') return t('activeJob.statusCancelled');
    if (isDone) {
      return job.completedAt
        ? t('activeJob.statusCompletedAt', {
            date: new Date(job.completedAt).toLocaleString(undefined, withNumerals()),
          })
        : t('activeJob.statusCompleted');
    }
    return job.startedAt
      ? t('activeJob.statusStartedAt', {
          date: new Date(job.startedAt).toLocaleString(undefined, withNumerals()),
        })
      : t('activeJob.statusQueued');
  })();

  return (
    <div className="mt-6 rounded-xl border-2 border-primary/30 bg-primary/5 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            {jobKindLabel(job.kind, job.direction, t)} {t('activeJob.sweepSuffix')}
          </h3>
          <p className="text-xs text-muted-foreground">{statusText}</p>
        </div>
        <div className="flex items-center gap-2">
          {isActive && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive-ink hover:bg-destructive/20 disabled:opacity-50"
            >
              {cancelling ? t('activeJob.cancelling') : t('activeJob.cancel')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {isDone ? t('activeJob.dismiss') : t('activeJob.hide')}
          </button>
        </div>
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-medium">
            {job.processed} / {job.total}
          </span>
          <span className="text-muted-foreground">{pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded bg-white/70">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <Stat label={t('stats.filled')} value={job.filled} tone="ok" />
        <Stat label={t('stats.skipped')} value={job.skipped} tone="muted" />
        <Stat
          label={t('stats.failed')}
          value={job.failed}
          tone={job.failed > 0 ? 'bad' : 'muted'}
        />
      </div>

      {job.errorMessage && <p className="mt-3 text-sm text-destructive-ink">{job.errorMessage}</p>}

      {filledList.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-emerald-600">
            {filledList.length === 1
              ? t('activeJob.viewFilled', { count: filledList.length })
              : t('activeJob.viewFilledPlural', { count: filledList.length })}
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {filledList.map(p => (
              <li key={p.id} className="rounded bg-white px-2 py-1.5">
                {storeId ? (
                  <Link
                    href={`/stores/${storeId}/products/${p.id}`}
                    className="font-medium text-foreground hover:text-primary-ink hover:underline"
                  >
                    {p.name}
                  </Link>
                ) : (
                  <span className="font-medium">{p.name}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {job.errors && job.errors.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            {job.errors.length === 1
              ? t('activeJob.viewFailures', { count: job.errors.length })
              : t('activeJob.viewFailuresPlural', { count: job.errors.length })}
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {job.errors.slice(0, 50).map((e, i) => (
              <li key={i} className="rounded bg-white px-2 py-1.5">
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
    </div>
  );
}

function MasterSweepCard({
  sweep,
  onCancel,
  onClose,
  t,
}: {
  sweep: MasterSweep;
  onCancel?: () => void;
  onClose: () => void;
  t: TFn;
}) {
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
    jobs.length > 0 &&
    jobs.every(j => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled');
  const anyFailed = jobs.some(j => j.status === 'failed');
  const anyActive = jobs.some(j => j.status === 'running' || j.status === 'queued');
  const pct =
    totals.total > 0 ? Math.min(100, Math.round((totals.processed / totals.total) * 100)) : 0;

  const overallStatus = allDone
    ? anyFailed
      ? 'failed'
      : jobs.every(j => j.status === 'cancelled')
        ? 'cancelled'
        : 'completed'
    : jobs.some(j => j.status === 'running')
      ? 'running'
      : 'queued';

  return (
    <div className="mt-6 rounded-xl border-2 border-primary/30 bg-primary/5 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{label}</h3>
          <div className="mt-0.5 flex items-center gap-2">
            <StatusBadge status={overallStatus} t={t} />
            <span className="text-xs text-muted-foreground">
              {jobs.map(j => jobKindLabel(j.kind, j.direction, t)).join(' + ')}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {anyActive && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive-ink hover:bg-destructive/20"
            >
              {t('activeJob.cancelAll')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {allDone ? t('activeJob.dismiss') : t('activeJob.hide')}
          </button>
        </div>
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-medium">
            {totals.processed} / {totals.total}
          </span>
          <span className="text-muted-foreground">{pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded bg-white/70">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <Stat label={t('stats.filled')} value={totals.filled} tone="ok" />
        <Stat label={t('stats.skipped')} value={totals.skipped} tone="muted" />
        <Stat
          label={t('stats.failed')}
          value={totals.failed}
          tone={totals.failed > 0 ? 'bad' : 'muted'}
        />
      </div>

      {/* Per-sub-job status chips */}
      <div className="mt-3 flex flex-wrap gap-2">
        {jobs.map(j => (
          <div
            key={j.id}
            className="flex items-center gap-1.5 rounded-full bg-white/60 px-3 py-1 text-xs"
          >
            <StatusBadge status={j.status} t={t} />
            <span className="font-medium">{jobKindLabel(j.kind, j.direction, t)}</span>
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
        ? 'text-destructive-ink'
        : 'text-muted-foreground';
  return (
    <div className="rounded-lg bg-white px-3 py-2">
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
