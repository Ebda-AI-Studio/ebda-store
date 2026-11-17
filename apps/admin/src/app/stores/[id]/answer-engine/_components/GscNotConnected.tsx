'use client';

import { useT } from '@/i18n/useT';
import type { GscDashboard } from './types';

/**
 * Empty state shown when `hasData:false` — the store has ZERO
 * `GscDailyMetric` rows (either GSC ingestion is globally dormant, the
 * property isn't accessible yet, or the store has no domain). Deliberately
 * distinct from the trend chart's own "no data" text so a merchant never
 * reads a flat zero-line chart as "your store gets zero search traffic" —
 * see gsc-dashboard.service.ts's file header for the full rationale.
 */
export function GscNotConnected({ setup }: { setup?: GscDashboard['setup'] }) {
  const t = useT('answerEngine.gsc');

  return (
    <div className="bg-card rounded-xl border border-dashed border-border p-6 text-center">
      <p className="text-sm font-medium text-foreground" dir="auto">
        {t(
          setup === 'verifying'
            ? 'verifyingTitle'
            : setup === 'awaiting_data'
              ? 'awaitingDataTitle'
              : 'notConnectedTitle'
        )}
      </p>
      <p className="mt-1.5 text-xs text-muted-foreground max-w-md mx-auto" dir="auto">
        {t(
          setup === 'verifying'
            ? 'verifyingBody'
            : setup === 'awaiting_data'
              ? 'awaitingDataBody'
              : 'notConnectedBody'
        )}
      </p>
    </div>
  );
}
