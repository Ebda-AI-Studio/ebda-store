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
const SKIP = new Set([
  'node_modules',
  '.next',
  '.open-next',
  'dist',
  'out',
  '.wrangler',
  '__tests__',
]);

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
      // `beforeSend` itself (not satisfied by the beforeSendTransaction line).
      expect(src).toMatch(/beforeSend(?!Transaction)[\s\S]{0,200}?scrubSentryEvent\(/);
      expect(src).toMatch(/beforeSendTransaction[\s\S]{0,80}scrubSentryEvent\(/);
      expect(src).toMatch(/beforeBreadcrumb[\s\S]{0,80}scrubSentryBreadcrumb\(/);
    }
  );
});

/**
 * Same class for PostHog: every `posthog.init(` (web / admin / orders providers and the shared
 * marketing + signup tracker) passes `before_send: scrubPostHogCapture`, so a `/search?q=<phone>`
 * pageview never leaves with the phone (the pipeline itself is proven in
 * posthog-search-query-scrub.test.ts).
 */
const phFiles = [
  ...walk(path.join(ROOT, 'apps')),
  ...walk(path.join(ROOT, 'packages/shared/src')),
].filter(f => /\bposthog\.init\(/.test(fs.readFileSync(f, 'utf8')));

describe('PostHog capture scrubbing is wired everywhere', () => {
  it('finds the known PostHog inits (guards the scan itself)', () => {
    expect(phFiles.map(f => path.relative(ROOT, f)).sort()).toEqual([
      'apps/admin/src/components/PostHogProvider.tsx',
      'apps/orders/src/components/PostHogProvider.tsx',
      'apps/web/src/components/PostHogProvider.tsx',
      'packages/shared/src/tracking/browser.ts',
    ]);
  });

  it.each(phFiles.map(f => [path.relative(ROOT, f)]))(
    '%s passes before_send: scrubPostHogCapture',
    rel => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toMatch(/posthog\.init\([\s\S]*?before_send:\s*scrubPostHogCapture/);
    }
  );
});
