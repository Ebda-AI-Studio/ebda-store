/**
 * `JOBS_CF_GROUPS` (a wrangler var, flipped only by a PR + deploy): which job groups run on
 * Cloudflare instead of Inngest. A comma list of group names or their number (`1,2` or
 * `1-observability`), or `all`. Empty = everything stays on Inngest.
 *
 * A job runs on Cloudflare only if its group is listed AND this process has the Workflows binding
 * (so Node / tests / scripts always keep the Inngest path).
 */
import { cfBindings } from '../../cf/bindings';
import { JOBS_MAP } from './jobs-map';

function tokens(): string[] {
  return (process.env.JOBS_CF_GROUPS ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

export function groupEnabled(group: string): boolean {
  const t = tokens();
  if (t.includes('all')) return true;
  return t.some(x => group === x || group.startsWith(`${x}-`));
}

export function jobRunsOnCf(id: string): boolean {
  const entry = JOBS_MAP[id];
  if (!entry || !groupEnabled(entry.group)) return false;
  const b = cfBindings();
  return !!b?.JOBS_WORKFLOW && !!b?.JOBS_QUEUE;
}
