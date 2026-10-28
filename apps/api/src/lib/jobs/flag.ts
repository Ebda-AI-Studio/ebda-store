/**
 * Does this process run the job on Cloudflare? Every mapped job does, once this process has the
 * Workflows and Queue bindings (the Worker). Node (tests, scripts, local dev) has no bindings, so
 * nothing starts there. (The per-group `JOBS_CF_GROUPS` rollout flag is gone with Inngest.)
 */
import { cfBindings } from '../../cf/bindings';
import { JOBS_MAP } from './jobs-map';

export function jobRunsOnCf(id: string): boolean {
  if (!JOBS_MAP[id]) return false;
  const b = cfBindings();
  return !!b?.JOBS_WORKFLOW && !!b?.JOBS_QUEUE;
}
