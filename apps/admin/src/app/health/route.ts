import { NextResponse } from 'next/server';

/**
 * Liveness probe for uptime monitoring (UptimeRobot) + the OS heal-watch.
 *
 * The admin app is a Next.js frontend, so it has no API-style `/health` —
 * external monitors hitting `admin.ebda.app/health` were getting a 404
 * and flagging the service down. This returns a lightweight 200 that proves
 * the worker is executing, without rendering the app or touching any backend.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ok', service: 'admin' }, { status: 200 });
}
