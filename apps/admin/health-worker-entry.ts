/**
 * Cloudflare Worker entry for ebda-admin: answers GET /health (commit + deploymentId) in front of the
 * OpenNext handler (Ruling HEALTH-ALL-1). A Next route handler cannot do it on this Worker: without an
 * incremental cache every route handler 500s. `scripts/cf-setup-local.sh` points wrangler `main` here.
 */
// @ts-expect-error — `.open-next/worker.js` is generated at build time by scripts/cf-build.sh.
import nextWorker from './.open-next/worker.js';
import { withHealth } from '@ebda/shared';

export default withHealth('admin', nextWorker);
