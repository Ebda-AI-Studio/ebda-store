'use client';

import { formatDate } from '@/lib/format';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { ErrorState } from '../../../../components/ErrorState';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { useAnswerEngineSummary } from './_hooks/useAnswerEngineSummary';
import { useGscDashboard } from './_hooks/useGscDashboard';
import { AnswerEngineSkeleton } from './_components/AnswerEngineSkeleton';
import { EngineSummaryCards } from './_components/EngineSummaryCards';
import { TrendChart } from './_components/TrendChart';
import { PromptResultsList } from './_components/PromptResultsList';
import { GscSectionSkeleton } from './_components/GscSectionSkeleton';
import { GscNotConnected } from './_components/GscNotConnected';
import { GscTotalsCards } from './_components/GscTotalsCards';
import { GscTrendChart } from './_components/GscTrendChart';
import { GscTopQueriesList } from './_components/GscTopQueriesList';

/**
 * Merchant-facing answer-engine (AEO/GEO citation) dashboard (Task 7).
 *
 * Mirrors `stores/[id]/analytics/page.tsx`'s structure: a feature gate via
 * `useRequireFeature('answer_engine_insights')` (`if (gate) return gate;`
 * AFTER all hooks, per that hook's documented usage pattern), a loading
 * skeleton, and a set of read-only cards fed by
 * `GET /stores/:storeId/answer-engine/summary`.
 */
export default function AnswerEnginePage() {
  const { enabled: featureEnabled, gate } = useRequireFeature('answer_engine_insights');

  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('answerEngine.page');

  const {
    summary,
    isLoading,
    error: summaryError,
    refetch: refetchSummary,
  } = useAnswerEngineSummary({ storeId, enabled: featureEnabled });
  const {
    gsc,
    isLoading: gscLoading,
    error: gscError,
    refetch: refetchGsc,
  } = useGscDashboard({ storeId, enabled: featureEnabled });
  const tGsc = useT('answerEngine.gsc');
  const tError = useT('components.errorState');

  if (gate) return gate;

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {isLoading ? (
        <AnswerEngineSkeleton />
      ) : summaryError !== null ? (
        <ErrorState message={summaryError || tError('loadFailed')} onRetry={refetchSummary} />
      ) : (
        <div className="space-y-6">
          {summary.lastRunAt && (
            <p className="text-xs text-muted-foreground">
              {t('lastRunAt', {
                date: formatDate(summary.lastRunAt),
              })}
            </p>
          )}

          <EngineSummaryCards engines={summary.engines} />

          <TrendChart trend={summary.trend} />

          <PromptResultsList storeId={storeId} prompts={summary.prompts} />

          <div className="pt-2">
            <h2 className="text-base font-semibold text-foreground mb-4" dir="auto">
              {tGsc('sectionTitle')}
            </h2>
            {gscLoading ? (
              <GscSectionSkeleton />
            ) : gscError !== null ? (
              // An error is not "not connected" — show it, with a retry.
              <ErrorState message={gscError || tError('loadFailed')} onRetry={refetchGsc} />
            ) : gsc.hasData && gsc.totals ? (
              <div className="space-y-6">
                <GscTotalsCards totals={gsc.totals} />
                <GscTrendChart trend={gsc.trend} />
                <GscTopQueriesList topQueries={gsc.topQueries} />
              </div>
            ) : (
              <GscNotConnected setup={gsc.setup} />
            )}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
