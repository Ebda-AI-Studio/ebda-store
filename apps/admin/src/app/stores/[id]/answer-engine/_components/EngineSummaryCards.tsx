'use client';

import { useT } from '@/i18n/useT';
import { engineLabel, formatPercent, type AnswerEngineSummaryEngine } from './types';

interface EngineSummaryCardsProps {
  engines: AnswerEngineSummaryEngine[];
}

function EngineCard({ engine }: { engine: AnswerEngineSummaryEngine }) {
  const t = useT('answerEngine.page');

  return (
    <div className="bg-card rounded-xl border border-border p-5">
      <p className="text-sm font-medium text-foreground">{engineLabel(engine.engine)}</p>
      <p className="mt-2 text-2xl font-bold text-foreground">
        {engine.citedCount}
        <span className="text-sm font-normal text-muted-foreground"> / {engine.totalChecks}</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('citedRate', { rate: formatPercent(engine.citedRate) })}
      </p>
      {engine.groundingUnavailable ? (
        <p
          className="mt-3 rounded-lg bg-warning/10 border border-warning/40 px-2.5 py-1.5 text-xs leading-snug text-warning-ink"
          dir="auto"
        >
          {t('groundingUnavailable')}
        </p>
      ) : (
        engine.groundedCaveat && (
          <p
            className="mt-3 rounded-lg bg-warning/10 border border-warning/40 px-2.5 py-1.5 text-xs leading-snug text-warning-ink"
            dir="auto"
          >
            {t('groundedCaveat')}
          </p>
        )
      )}
    </div>
  );
}

/** Cited-count-per-engine card grid + the grounded caveat badge (Task 7). */
export function EngineSummaryCards({ engines }: EngineSummaryCardsProps) {
  const t = useT('answerEngine.page');

  if (engines.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noData')}</p>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {engines.map(engine => (
        <EngineCard key={engine.engine} engine={engine} />
      ))}
    </div>
  );
}
