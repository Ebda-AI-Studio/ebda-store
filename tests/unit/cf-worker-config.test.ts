import ts from 'typescript';
/**
 * The Cloudflare Worker's configuration (R-EBDA-001, SP4 Stage 1): what wrangler.jsonc may and may
 * not say, and that the scheduled schedules the code handles are the ones the config declares.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_SCHEDULE } from '@api/cf/cron';

const ROOT = join(__dirname, '..', '..');
const api = (p: string) => readFileSync(join(ROOT, 'apps/api', p), 'utf8');

/** wrangler.jsonc is JSON with comments and trailing commas. */
function parseJsonc(text: string): Record<string, any> {
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  return parsed.config;
}

const config = parseJsonc(api('wrangler.jsonc'));

describe('wrangler.jsonc', () => {
  it('runs Express on workerd: nodejs_compat, the Worker entry, a pinned compatibility date', () => {
    expect(config.main).toBe('src/worker.ts');
    expect(config.compatibility_flags).toContain('nodejs_compat');
    expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('binds NO Hyperdrive / Postgres: the Worker has none (NEON-ZERO N-17, Ruling NZ-D23)', () => {
    expect(config.hyperdrive).toBeUndefined();
    expect(api('wrangler.jsonc')).not.toMatch(/"hyperdrive"|"HYPERDRIVE"/);
  });

  it('holds no secret: every secret-shaped var is absent and the only password is the repo-wide fake one', () => {
    const text = api('wrangler.jsonc');
    const vars = Object.keys(config.vars ?? {});
    for (const name of vars) {
      expect(
        name,
        `${name} looks like a secret and belongs in wrangler secret / .dev.vars`
      ).not.toMatch(/SECRET|PASSWORD|TOKEN|KEY|DSN/i);
    }
    const passwords = [...text.matchAll(/:\/\/[^:\s"]+:([^@\s"]+)@/g)].map(m => m[1]);
    expect(passwords.every(p => p === 'ci-only-app-pw')).toBe(true);
    expect(text).not.toMatch(/sk_(live|test)_|-----BEGIN|AKIA[0-9A-Z]{12}/);
  });

  it('declares every binding the code reads', () => {
    const doNames = config.durable_objects.bindings.map((b: any) => b.name);
    expect(doNames).toEqual(
      expect.arrayContaining(['AUTH_STATE', 'STORE_REALTIME', 'JOB_GATE', 'STORE_SCHEDULE'])
    );
    expect(config.kv_namespaces.map((k: any) => k.binding)).toContain('KV_CACHE');
    expect(config.queues.producers.map((p: any) => p.binding)).toEqual(
      expect.arrayContaining(['EMAIL_QUEUE', 'SMS_QUEUE', 'JOBS_QUEUE'])
    );
    expect(config.ratelimits.map((r: any) => r.name)).toContain('RATE_LIMITER');
    expect(config.version_metadata.binding).toBe('CF_VERSION_METADATA');
  });

  it('both Durable Objects are SQLite-backed and exported by the entry', () => {
    const created = config.migrations.flatMap((m: any) => m.new_sqlite_classes ?? []);
    expect(created).toEqual(expect.arrayContaining(['AuthState', 'StoreRealtime']));
    const entry = api('src/worker.ts');
    expect(entry).toMatch(/export \{ AuthState \}/);
    expect(entry).toMatch(/export \{ StoreRealtime \}/);
  });

  it('every queue has a consumer with retries and a dead-letter queue, and the DLQs are consumed', () => {
    const consumers = config.queues.consumers as Array<Record<string, any>>;
    for (const q of ['ebda-email', 'ebda-sms', 'ebda-jobs']) {
      const c = consumers.find(x => x.queue === q)!;
      expect(c.max_retries).toBeGreaterThan(0);
      expect(c.dead_letter_queue).toBe(`${q}-dlq`);
      expect(consumers.some(x => x.queue === `${q}-dlq`)).toBe(true);
    }
  });

  it('Node-only packages are aliased to Workers code, and every alias target exists', () => {
    const alias = config.alias as Record<string, string>;
    for (const pkg of [
      'ioredis',
      'socket.io',
      'rate-limit-redis',
      'imapflow',
      'pino',
      'multer',
      '@sentry/node',
    ]) {
      expect(alias[pkg], pkg).toBeTruthy();
    }
    for (const target of Object.values(alias)) {
      expect(() => readFileSync(join(ROOT, 'apps/api', target)), target).not.toThrow();
    }
  });
});

describe('Cron Triggers', () => {
  it('every schedule the code handles is declared in wrangler.jsonc, and every declared one has jobs', () => {
    const declared: string[] = [...config.triggers.crons].sort();
    // The legacy loops are a subset of the declared schedules; the rest are Inngest schedules ported
    // to Cloudflare, pinned by tests/unit/jobs-schedule.test.ts.
    expect(declared).toEqual(expect.arrayContaining(Object.keys(CRON_SCHEDULE)));
    for (const jobs of Object.values(CRON_SCHEDULE)) expect(jobs.length).toBeGreaterThan(0);
  });
});

describe('SEARCH_SEMANTIC_ENABLED is a reviewed var, never a secret (review I2)', () => {
  it('is declared in vars, default "true" (semantic search is on), so a flip is a PR + cf-api-deploy (post-deploy probe runs)', () => {
    expect(config.vars.SEARCH_SEMANTIC_ENABLED).toBe('true');
  });
  it('cf-api-deploy refuses to deploy when it is set as a Worker secret', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/cf-api-deploy.yml'), 'utf8');
    const step = wf.slice(wf.indexOf('Require configured runtime secrets'));
    expect(step.slice(0, step.indexOf('- name:', 10))).toMatch(
      /\["SEARCH_SEMANTIC_ENABLED"\][^\n]*names\.has\(name\)[^\n]*must be a wrangler\.jsonc var/
    );
  });
});
