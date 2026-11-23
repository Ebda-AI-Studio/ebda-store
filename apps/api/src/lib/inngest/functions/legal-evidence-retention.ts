import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import { runLegalEvidenceRetention } from '../../../services/legal-evidence-retention';
import logger from '../../logger';

/**
 * Consent-evidence retention (Ruling NZ-N27B), daily: ip + user agent older than 12 months become NULL, rows older than 7 years
 * (RETENTION_YEARS) are deleted. Platform D1 rows only; no store table is opened. One idempotent unit, so no `step.run`
 * (a step wrapper would only add a billed execution); a failure retries the run.
 */
export const legalEvidenceRetention: JobDef = inngest.createFunction(
  {
    id: 'legal-evidence-retention',
    name: 'Null old consent ip/user-agent, delete consent evidence past retention',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '41 3 * * *' }],
  },
  async () => {
    const r = await runLegalEvidenceRetention();
    logger.info({ nulled: r.nulled, deleted: r.deleted }, '[legal-evidence-retention] done');
    return r;
  }
);
