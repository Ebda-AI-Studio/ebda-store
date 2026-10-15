/**
 * Every Sentry client we start (API Worker + Node, web / admin / orders browser, server and
 * edge) scrubs free-text query values (?search=, ?q=, ?email=, ?phone=) from events,
 * transactions and breadcrumbs (search log review, fix-the-class: a phone pasted into the
 * storefront search box must not reach Sentry through the URL).
 *
 * Static: finds every `Sentry.init(` / `Sentry.withSentry(` in the apps and requires the three
 * hooks to call the shared scrubbers. A new init without them fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SKIP = new Set(['node_modules', '.next', '.open-next', 'dist', '.wrangler', '__tests__']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(path.join(ROOT, 'apps')).filter(f =>
  /Sentry\.(init|withSentry)\(/.test(fs.readFileSync(f, 'utf8'))
);

describe('Sentry query-string scrubbing is wired everywhere', () => {
  it('finds the known Sentry entry points (guards the scan itself)', () => {
    const rel = files.map(f => path.relative(ROOT, f)).sort();
    expect(rel).toEqual(
      expect.arrayContaining([
        'apps/api/src/services/sentry.service.ts',
        'apps/api/src/worker.ts',
        'apps/web/instrumentation-client.ts',
        'apps/web/sentry.server.config.ts',
        'apps/web/sentry.edge.config.ts',
        'apps/admin/instrumentation-client.ts',
        'apps/admin/sentry.server.config.ts',
        'apps/admin/sentry.edge.config.ts',
        'apps/orders/instrumentation-client.ts',
      ])
    );
  });

  it.each(files.map(f => [path.relative(ROOT, f)]))(
    '%s scrubs events, transactions and breadcrumbs',
    rel => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toMatch(/beforeSend[\s\S]{0,200}scrubSentryEvent\(/);
      expect(src).toMatch(/beforeSendTransaction[\s\S]{0,80}scrubSentryEvent\(/);
      expect(src).toMatch(/beforeBreadcrumb[\s\S]{0,80}scrubSentryBreadcrumb\(/);
    }
  );
});
