import { NextResponse } from 'next/server';

/**
 * Liveness probe for uptime monitoring (UptimeRobot) + the OS heal-watch.
 *
 * The admin app is a Next.js frontend, so it has no API-style `/health` —
 * external monitors hitting `store.ebda.app/health` were getting a 404
 * and flagging the service down. This returns a lightweight 200 that proves
 * the worker is executing, without rendering the app or touching any backend.
 */
export const dynamic = 'force-dynamic';

/** M-070: the commit this worker was deployed from (`wrangler deploy --var BUILD_COMMIT_SHA`), so Rule F can compare it to main. */
export function GET() {
  const commit = process.env.BUILD_COMMIT_SHA?.trim() || null;
  return NextResponse.json({ status: 'ok', service: 'admin', commit }, { status: 200 });
}
