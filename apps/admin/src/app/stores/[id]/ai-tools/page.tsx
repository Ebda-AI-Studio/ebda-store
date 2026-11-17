'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useConfirm } from '@/hooks/useConfirm';
import { apiGet, apiPost } from '../../../../lib/api';
import { GeoResultsPanel } from './_components/GeoResultsPanel';
import { AiSweepResultsPanels } from './_components/AiSweepResultsPanels';
import { AiToolCard } from './_components/AiToolCard';
import {
  ActiveJobCard,
  MasterSweepCard,
  RunsEmpty,
  StatusBadge,
  isTerminal,
  jobKindLabel,
  type RunJob,
} from './_components/AiRunProgress';
import {
  TOOL_SECTIONS,
  blockReasonFor,
  type StartKey,
  type ToolSpec,
} from './_components/tool-catalog';
import {
  AiUsageSummaryCard,
  type AiUsageSummary,
} from '../../../../components/ai/AiUsageSummaryCard';
import { AiSwitchCard } from '../../../../components/ai/AiSwitchCard';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { useT } from '../../../../i18n/useT';
import { DataTable, type DataTableColumn } from '../../../../components/mobile/DataTable';
import { withNumerals } from '@ebda/shared';
import { Button, buttonVariants } from '@/components/ui/Button';
import { SparkleIcon } from '@/components/SparkleIcon';

/**
 * AI tools: catalogue-wide AI fills (translation, search text, answers for AI assistants, product details).
 * Each run becomes a BulkAiJob processed by an Inngest function; this page polls its progress. The smart-skip rule is
 * enforced server-side: blanks are filled, filled fields are left alone unless the merchant asks to replace them.
 *
 * Layout (UX pass, 2026-11-15): quota first, then the live run (right under it, so a click is never silent), then the
 * tool groups rendered from tool-catalog.ts through one card, then what the store has now, then run history.
 */

type BulkAiJob = RunJob & { createdAt: string };
type BulkAiJobDetail = BulkAiJob;

/** Jobs launched by a master button, tracked as a unit. */
interface MasterSweep {
  masterRunId: string;
  jobIds: string[];
  label: string;
  jobs: BulkAiJobDetail[];
}

// Poll cadence for active bulk-AI jobs. 4s: progress feels live, and stays under the global
// 100 req / 15 min ip-keyed rate limiter.
const POLL_MS = 4000;

export default function AiToolsPage() {
  const t = useT('aiTools');
  const askConfirm = useConfirm();
  const confirmCancelSweep = () =>
    askConfirm({
      object: t('cancelObject'),
      consequence: t('cancelConsequence'),
      confirmLabel: t('cancelAction'),
    });
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
  const [starting, setStarting] = useState<StartKey | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null); // jobId being cancelled
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);

  // Master "replace existing" switches, one per group.
  const [masterForce, setMasterForce] = useState<Record<string, boolean>>({});

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
      const fetched = results.filter((j): j is BulkAiJobDetail => !!j);
      setActiveMaster(prev => (prev ? { ...prev, jobs: fetched } : null));
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

  // A run that just started appears above the tools; bring it into view so a click is never silent.
  const runId = activeJob?.id ?? activeMaster?.masterRunId ?? null;
  useEffect(() => {
    if (runId) progressRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [runId]);

  type BulkEstimate = {
    products: number;
    requests: number;
    remaining: number;
    limitedBy: 'store_daily' | 'global_daily' | 'monthly';
    aiEnabled: boolean;
    canStart: boolean;
    fits: boolean;
  };

  /**
   * G18: before any bulk run, show what it can cost against the store's remaining AI quota. Hard stop only when the run
   * cannot start at all (AI off, or no requests left): the estimate is an upper bound that ignores smart-skip, so a run
   * that "does not fit" is warned about, not refused (a big catalogue would otherwise never be able to run). The server
   * still enforces the cap per call, so a failed estimate never blocks. Returns true when the run may go ahead.
   */
  async function confirmEstimate(kind: string): Promise<boolean> {
    const { data } = await apiGet<BulkEstimate>(
      `/api/v1/stores/${storeId}/ai/bulk/estimate?kind=${encodeURIComponent(kind)}`
    );
    if (!data || data.requests === 0) return true;
    if (!data.aiEnabled) {
      setError(t('estimateAiOff'));
      return false;
    }
    if (!data.canStart) {
      setError(
        t('estimateBlocked', {
          limit: t(
            {
              store_daily: 'estimateLimitStoreDaily',
              global_daily: 'estimateLimitGlobalDaily',
              monthly: 'estimateLimitMonthly',
            }[data.limitedBy] as 'estimateLimitStoreDaily'
          ),
        })
      );
      return false;
    }
    return askConfirm({
      object: t('estimateObject'),
      consequence: t(data.fits ? 'estimateConsequence' : 'estimatePartial', {
        requests: data.requests,
        products: data.products,
        remaining: data.remaining,
      }),
      confirmLabel: t('estimateAction'),
      tone: 'default',
    });
  }

  /** Shared starter. Handles smart-skip (default) and force paths. */
  async function start(endpoint: string, key: StartKey, body: object = {}, force = false) {
    setError(null);
    if (!(await confirmEstimate(endpoint.replace(/^\/bulk\//, '')))) return;
    if (force) {
      const ok = await askConfirm({
        object: t('replaceObject'),
        consequence: t('replaceConsequence'),
        confirmLabel: t('replaceAction'),
      });
      if (!ok) return;
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

  const anyRunning =
    (!!activeJob && !isTerminal(activeJob.status)) ||
    (!!activeMaster && activeMaster.jobs.some(j => !isTerminal(j.status)));

  const quotaBlock = blockReasonFor(usage, aiEnabled);
  const blockText: string | null =
    quotaBlock === 'off'
      ? t('blocked.off')
      : quotaBlock === 'daily'
        ? t('blocked.daily')
        : quotaBlock === 'monthly'
          ? t('blocked.monthly')
          : anyRunning
            ? t('blocked.running')
            : null;

  async function cancelJob(jobId: string) {
    if (!(await confirmCancelSweep())) return;
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
    if (!(await confirmCancelSweep())) return;
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
      cell: j => <span className="font-medium text-success-ink">{j.filled}</span>,
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
        <Button
          variant="link"
          size="sm"
          type="button"
          onClick={() => fetchActiveJob(j.id).then(() => undefined)}
        >
          {t('recentRuns.details')}
        </Button>
      ),
    },
  ];

  function renderTool(tool: ToolSpec) {
    const c = `cards.${tool.copy}`;
    return (
      <AiToolCard
        key={tool.key}
        id={`tool-${tool.key}`}
        title={t(`${c}.title`)}
        outcome={t(`${c}.outcome`)}
        body={t(`${c}.body`)}
        costLabel={t(`cost.${tool.cost}`)}
        buttonLabel={t(`${c}.button`)}
        startingLabel={t('starting')}
        loading={starting === tool.key}
        blockedReason={blockText}
        onRun={force => start(tool.endpoint, tool.key, tool.body ?? {}, force)}
        isUndo={tool.isUndo}
        replace={
          tool.canReplace
            ? {
                label: t('replaceExisting'),
                hint: t(`${c}.forceTooltip`),
                noUndo: tool.undoable ? null : t('replaceNoUndo'),
              }
            : undefined
        }
        fillOnlyNote={tool.canReplace ? undefined : t('fillOnlyNote')}
        results={
          tool.resultsPath
            ? { href: `/stores/${storeId}${tool.resultsPath}`, label: t(`${c}.resultsLabel`) }
            : undefined
        }
      />
    );
  }

  // Render gate (upsell page) for store_admin when feature is disabled.
  // Super-admin always passes through so they can configure the feature.
  if (gate) return gate;

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="space-y-4">
        <AiSwitchCard storeId={storeId} onChange={setAiEnabled} />
        {/* AI allowance: visible before any run button. */}
        <AiUsageSummaryCard storeId={storeId} embedded={true} onLoaded={setUsage} />

        {quotaBlock && quotaBlock !== 'off' && (
          <div
            role="status"
            className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-ink"
          >
            {t(quotaBlock === 'daily' ? 'blocked.dailyBanner' : 'blocked.monthlyBanner')}{' '}
            <Link href={`/stores/${storeId}/ai-usage`} className="font-medium underline">
              {t('blocked.seeUsage')}
            </Link>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive-ink"
          >
            {error}
          </div>
        )}

        {/* Live run, right under the allowance: starting a tool never leaves the merchant staring at nothing. */}
        <div ref={progressRef} className="scroll-mt-24 space-y-4 empty:hidden">
          {activeMaster && (
            <MasterSweepCard
              label={activeMaster.label}
              jobs={activeMaster.jobs}
              onCancel={() => cancelMasterSweep(activeMaster)}
              onClose={() => {
                setActiveMaster(null);
                fetchJobs();
              }}
              t={t}
            />
          )}
          {activeJob && (
            <ActiveJobCard
              job={activeJob}
              storeId={storeId}
              cancelling={cancelling === activeJob.id}
              onCancel={() => cancelJob(activeJob.id)}
              onClose={() => {
                setActiveJob(null);
                fetchJobs();
              }}
              t={t}
            />
          )}
        </div>
      </div>

      <nav aria-label={t('nav.label')} className="-mx-1 mt-6 overflow-x-auto px-1 pb-1">
        <ul className="flex w-max gap-2">
          {TOOL_SECTIONS.map(s => (
            <li key={s.id}>
              <a
                href={`#section-${s.id}`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t(`sections.${s.copyKey}`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {TOOL_SECTIONS.map(section => (
        <section
          key={section.id}
          id={`section-${section.id}`}
          aria-labelledby={`section-${section.id}-title`}
          className="mt-8 scroll-mt-24"
        >
          <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
            <div className="min-w-0 max-w-prose">
              <h2
                id={`section-${section.id}-title`}
                className="text-lg font-semibold text-foreground"
              >
                {t(`sections.${section.copyKey}`)}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t(`sectionsDesc.${section.copyKey}`)}
              </p>
            </div>
            {section.master && (
              <div className="flex flex-col items-start gap-2 sm:items-end">
                <label className="flex min-h-11 cursor-pointer select-none items-center gap-2 text-sm sm:min-h-8">
                  <input
                    type="checkbox"
                    checked={!!masterForce[section.id]}
                    onChange={e =>
                      setMasterForce(prev => ({ ...prev, [section.id]: e.target.checked }))
                    }
                    className="h-4 w-4 cursor-pointer accent-primary"
                  />
                  <span>{t('replaceExisting')}</span>
                </label>
                {masterForce[section.id] && (
                  <p role="status" className="max-w-xs text-xs text-warning-ink">
                    {t(
                      section.id === 'aeo'
                        ? 'masterSweep.aeoForceTooltip'
                        : 'masterSweep.geoForceTooltip'
                    )}{' '}
                    {t('replaceNoUndo')}
                  </p>
                )}
                <Button
                  variant="outline"
                  size="md"
                  type="button"
                  disabled={starting === section.master.key || blockText !== null}
                  onClick={() =>
                    start(
                      section.master!.endpoint,
                      section.master!.key,
                      section.master!.body,
                      !!masterForce[section.id]
                    )
                  }
                >
                  <SparkleIcon />
                  {starting === section.master.key
                    ? t('starting')
                    : t(section.id === 'aeo' ? 'masterSweep.runAllAeo' : 'masterSweep.runAllGeo')}
                </Button>
                <p className="max-w-xs text-xs text-muted-foreground">
                  {t(section.id === 'aeo' ? 'masterSweep.aeoNote' : 'masterSweep.geoNote')}
                </p>
              </div>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {section.tools.map(renderTool)}
          </div>
        </section>
      ))}

      {/* What the store has now: closes the every-data-has-a-UI gap for the sweeps above. */}
      <section id="ai-results" className="mt-10 scroll-mt-24">
        <GeoResultsPanel storeId={storeId} refreshTrigger={jobs.length} />
        <AiSweepResultsPanels storeId={storeId} />
      </section>

      {/* History: every run, newest first. */}
      <section className="mt-10" aria-labelledby="recent-runs-title">
        <h2 id="recent-runs-title" className="mb-3 text-lg font-semibold">
          {t('recentRuns.title')}
        </h2>
        <DataTable<BulkAiJob>
          ariaLabel={t('recentRuns.title')}
          columns={recentRunsColumns}
          rows={jobs}
          rowKey={j => j.id}
          emptyState={<RunsEmpty t={t} />}
        />
      </section>
    </AdminLayout>
  );
}
