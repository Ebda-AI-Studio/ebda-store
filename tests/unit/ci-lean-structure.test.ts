/**
 * Lean CI (SP4 task 9): the shape of .github/workflows/ci.yml and the
 * workspace-affected logic in scripts/ci-affected.mjs.
 *
 * Pull requests run only lint, typecheck and unit tests for the paths that
 * changed (fast merges). Ruling CI-FULL-MAIN-1 (2026-11-10): every push to main,
 * every cron and a manual dispatch run the FULL lane (build, integration,
 * workerd, e2e, audit); mutation is the Sunday cron or a ticked dispatch.
 * Budget: docs/ebda/ci.md. A job that drifts into the wrong lane is either a
 * slow PR or a main that is no longer proven, so the lanes are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
// @ts-expect-error - plain .mjs script, no type declarations
import { classify, loadWorkspaces, UNIT_PATHS } from '../../scripts/ci-affected.mjs';

const ROOT = path.resolve(__dirname, '../..');
const raw = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

type Job = {
  outputs?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  'runs-on'?: string;
  steps?: unknown[];
};
const ci = yaml.load(raw) as {
  on: Record<string, any>;
  concurrency: { group: string; 'cancel-in-progress': string };
  env: Record<string, string>;
  jobs: Record<string, Job>;
};

/** The jobs that must never run on a pull request. */
const MAIN_LANE = [
  'build',
  'test-unit',
  'orphan-tests',
  'test-e2e',
  'builder-e2e',
  'security',
  'mutation',
];
const PR_LANE = [
  'changes',
  'guards',
  'lint',
  'typecheck',
  'unit',
  'worker-dry-run',
  'api-workerd-smoke',
  'workerd-integration',
  'app-build',
  'app-builds',
  // runs on a PR ONLY when scripts/ci-affected.mjs selects integration tests (#227); full tier in the main lane
  'test-integration',
];

/** Does the job (or, through `needs`, a job it waits on) skip on pull_request? */
function skipsOnPr(name: string, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const job = ci.jobs[name];
  if (
    job.if &&
    /github\.event_name\s*!=\s*'pull_request'|github\.event_name\s*==\s*'(schedule|workflow_dispatch)'/.test(
      job.if
    )
  )
    return true;
  const needs = ([] as string[]).concat(job.needs ?? []);
  return needs.some(n => skipsOnPr(n, seen));
}

describe('ci.yml triggers', () => {
  it('runs on PRs to main, pushes to main, a nightly (Mon-Sat) + Sunday full run and manual dispatch', () => {
    expect(ci.on.pull_request.branches).toEqual(['main']);
    expect(ci.on.push.branches).toEqual(['main']);
    expect(ci.on.schedule.map((e: { cron: string }) => e.cron)).toEqual([
      '17 1 * * 1-6',
      '17 1 * * 0',
    ]);
    expect(ci.on).toHaveProperty('workflow_dispatch');
  });

  it('every `github.event.schedule ==` condition names a cron that is actually declared', () => {
    const declared = ci.on.schedule.map((e: { cron: string }) => e.cron);
    const used = [...raw.matchAll(/github\.event\.schedule == '([^']+)'/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const u of used) expect(declared, u).toContain(u);
  });

  it('cancels superseded PR runs and superseded main pushes, never a cron or manual run', () => {
    expect(ci.concurrency.group).toMatch(/^ci-/);
    // PR runs group per ref, every main push shares one group, anything else is alone (run_id)
    expect(ci.concurrency.group).toBe(
      "ci-${{ github.event_name == 'pull_request' && github.ref || (github.event_name == 'push' && 'main-push' || github.run_id) }}"
    );
    expect(ci.concurrency['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' || github.event_name == 'push' }}"
    );
  });

  it('uses Node 22 (wrangler >= 4.110) and caches npm (hosted runners only) in every setup-node that installs', () => {
    expect(ci.env.NODE_VERSION).toBe('22');
    const steps = raw.split('uses: actions/setup-node@').slice(1);
    expect(steps.length).toBeGreaterThan(8);
    // Exactly one setup-node skips the cache: the `changes` job, which only
    // runs the dependency-free scripts/ci-affected.mjs and installs nothing.
    const uncached = steps.filter(
      b =>
        !/^[^\n]*\n\s+with:[\s\S]*?cache: \$\{\{ \(!contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci-umbra'\) && vars\.EBDA_RUNS_ON == ''\) && 'npm' \|\| '' \}\}/.test(
          b.split('\n\n')[0] + '\n'
        )
    );
    expect(uncached).toHaveLength(1);
  });
});

describe('ci.yml lanes', () => {
  it('every job is declared in exactly one lane (a new job must pick one)', () => {
    const declared = new Set([...PR_LANE, ...MAIN_LANE, 'notify-failure']);
    expect(Object.keys(ci.jobs).sort()).toEqual([...declared].sort());
  });

  it.each(MAIN_LANE)('%s never runs on a pull request', name => {
    expect(skipsOnPr(name), `${name} is reachable from a pull_request`).toBe(true);
  });

  it('Integration Tests: the full tier in the main lane, and on a PR only the files the planner selects (#227)', () => {
    const j = ci.jobs['test-integration'];
    const cond = j.if ?? '';
    expect(([] as string[]).concat(j.needs ?? []).sort()).toEqual(['build', 'changes']);
    // main lane: after a successful build, never on a PR
    expect(cond).toMatch(
      /github\.event_name != 'pull_request' && needs\.build\.result == 'success'/
    );
    // PR lane: only when the planner says so
    expect(cond).toMatch(
      /github\.event_name == 'pull_request' && needs\.changes\.outputs\.integration == 'true'/
    );
    expect(ci.jobs.changes.outputs).toMatchObject({
      integration: expect.any(String),
      integration_paths: expect.any(String),
    });
    // a PR runs just the selected files; the main lane keeps the whole tier
    expect(raw).toContain('INTEGRATION_PATHS: ${{ needs.changes.outputs.integration_paths }}');
    expect(raw).toMatch(/targets="tests\/integration apps\/api\/src"/);
    expect(raw).toMatch(/npx vitest run \$targets /);
  });

  it('mutation tests are weekly or manual only, never on a push', () => {
    const cond = ci.jobs.mutation.if ?? '';
    expect(cond).toMatch(
      /github\.event_name == 'schedule' && github\.event\.schedule == '17 1 \* \* 0'/
    );
    expect(cond).toMatch(/workflow_dispatch/);
    expect(cond).not.toMatch(/'push'/);
    expect(raw).toMatch(/npx stryker run/);
    expect(raw).toMatch(/defence-mutation-record\.mjs --tier=unit/);
  });

  // Ruling CI-FULL-MAIN-1: evaluate each job's `if:` for an event (a small, closed evaluator: anything it cannot
  // rewrite throws, so a new expression shape fails here instead of silently passing).
  const runsOn = (event: string, schedule = '', seen = new Map<string, boolean>()) => {
    const run = (name: string): boolean => {
      if (seen.has(name)) return seen.get(name)!;
      const j = ci.jobs[name];
      const needs = ([] as string[]).concat(j.needs ?? []);
      let res: boolean;
      if (!j.if) res = needs.every(run);
      else {
        const expr = j.if
          .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
          .replace(/needs\.([\w-]+)\.result == 'success'/g, (_, n) => String(run(n)))
          .replace(/needs\.[\w-]+\.outputs\.\w+ (==|!=) '[^']*'/g, (_, op) =>
            String(op === '!=' ? false : false)
          )
          .replace(/github\.event\.schedule/g, `'${schedule}'`)
          .replace(/github\.event_name/g, `'${event}'`)
          .replace(/inputs\.mutation/g, 'false')
          .replace(/!cancelled\(\)/g, 'true')
          .replace(/always\(\)/g, 'true')
          .replace(/==/g, '===')
          .replace(/!=/g, '!==');
        if (!/^[\s'\w*\- ()!=&|]+$/.test(expr)) throw new Error(`${name}: cannot evaluate ${expr}`);
        res = Boolean(new Function(`return (${expr});`)());
      }
      seen.set(name, res);
      return res;
    };
    return Object.keys(ci.jobs).filter(run).sort();
  };
  const PR_ONLY = ['changes', 'lint', 'typecheck', 'unit', 'app-build', 'app-builds'];
  const FULL_LANE = Object.keys(ci.jobs)
    .filter(j => !PR_ONLY.includes(j) && j !== 'mutation')
    .sort();

  it('a push to main runs the FULL lane except mutation (build, unit, integration, workerd, e2e, audit)', () => {
    expect(runsOn('push')).toEqual(FULL_LANE);
    for (const j of [
      'build',
      'test-unit',
      'test-integration',
      'test-e2e',
      'builder-e2e',
      'security',
      'api-workerd-smoke',
      'workerd-integration',
      'orphan-tests',
      'notify-failure',
    ])
      expect(runsOn('push'), j).toContain(j);
  });

  it('the full lane dry-runs marketing so its page-weight budget is proven on main (Ruling MKT-LEGAL-HTML-BUDGET-2)', () => {
    for (const ev of ['push', 'workflow_dispatch'])
      expect(runsOn(ev), ev).toContain('worker-dry-run');
    const job = ci.jobs['worker-dry-run'] as Job & { strategy: { matrix: { app: string } } };
    expect(job.strategy.matrix.app).toContain(
      `github.event_name == 'pull_request' && needs.changes.outputs.workers || '["marketing"]'`
    );
    expect(raw).toMatch(
      /name: Marketing page-weight budget\n\s+if: matrix\.app == 'marketing'\n\s+run: node scripts\/ci\/marketing-perf-budget\.mjs/
    );
  });

  it('the nightly cron runs the full lane, the Sunday cron adds mutation, neither depends on EBDA_RUNS_ON', () => {
    expect(runsOn('schedule', '17 1 * * 1-6')).toEqual(FULL_LANE);
    expect(runsOn('schedule', '17 1 * * 0')).toEqual([...FULL_LANE, 'mutation'].sort());
    expect(runsOn('workflow_dispatch')).toEqual(FULL_LANE);
    // Ruling CI-HOSTED-1's scheduled no-op is retired
    expect(raw).not.toMatch(/vars\.EBDA_RUNS_ON != ''/);
  });

  it('the full lane runs the WHOLE workers-test suite (route-sweep included), a PR the slice', () => {
    expect(raw).toMatch(
      /if \[ "\$EVENT" = "pull_request" \]; then\n(\s+#[^\n]*\n)+\s+npm run cf:test -w apps\/api -- \$\(node scripts\/ci\/workers-test-lane\.mjs\)/
    );
    expect(raw).toMatch(/else\n\s+# full lane[^\n]*\n\s+npm run cf:test -w apps\/api\n/);
  });

  it('a red full lane on main opens or updates the ci-main-red issue, and a green one closes it', () => {
    const n = ci.jobs['notify-failure'] as Job & { permissions?: Record<string, string> };
    expect(n.permissions?.issues).toBe('write');
    expect(raw).toMatch(/gh issue create --label ci-main-red/);
    expect(raw).toMatch(/gh issue close "\$num"/);
    // a job that hits its timeout reports `cancelled` (run 42820243819): that is red too, never "green"
    expect(raw).toContain(
      "if: (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')) && github.ref == 'refs/heads/main'"
    );
    expect(raw).toContain(
      "!contains(needs.*.result, 'cancelled') && github.ref == 'refs/heads/main'"
    );
    const needs = ([] as string[]).concat(n.needs ?? []);
    for (const j of FULL_LANE.filter(j => j !== 'notify-failure')) expect(needs, j).toContain(j);
  });

  it('the PR lane runs lint, typecheck and unit tests for changed paths only', () => {
    for (const name of ['lint', 'typecheck', 'unit', 'worker-dry-run']) {
      expect(ci.jobs[name].needs, name).toEqual(['changes']);
      expect(ci.jobs[name].if, name).toMatch(/needs\.changes\.outputs\./);
    }
    expect(ci.jobs.changes.if).toBe("github.event_name == 'pull_request'");
  });

  it('the always-on guards run the no-inherited-branding test, the pin check and the migration gate', () => {
    const g = ci.jobs.guards;
    expect(g.needs).toBeUndefined();
    expect(g.if).toBeUndefined();
    expect(JSON.stringify(g.steps)).toMatch(/no-force-branding\.test\.ts/);
    expect(JSON.stringify(g.steps)).toMatch(/check-action-pins\.sh/);
    expect(JSON.stringify(g.steps)).toMatch(/check-migration-order\.mjs/);
  });

  it('keeps the integration job on ebda_app (never the superuser) and Redis in the main lane', () => {
    expect(raw).toMatch(/DB role check: current_user=ebda_app rolbypassrls=false/);
    expect(raw).toMatch(/image: redis:7-alpine/);
    // Ruling NZ-17-RLS-1: the dedicated RLS proof / payload-parity jobs are gone with the production Postgres
    expect(ci.jobs['test-rls-ebda-app']).toBeUndefined();
    expect(ci.jobs['test-rls-payload-parity']).toBeUndefined();
  });

  it('the PR unit paths are a subset of the main-lane unit globs', () => {
    const mainRun = raw
      .split('\n')
      .find(l => l.includes('vitest run tests/unit packages/shared/src'))!;
    for (const p of Object.values(UNIT_PATHS).flat() as string[]) expect(mainRun, p).toContain(p);
  });
});

describe('scripts/ci-affected.mjs', () => {
  const ws = loadWorkspaces(ROOT);
  const run = (...files: string[]) => classify(files, ws);

  it('finds the real workspaces', () => {
    const dirs = ws.map((w: { dir: string }) => w.dir);
    expect(dirs).toEqual(
      expect.arrayContaining(['apps/api', 'apps/web', 'apps/admin', 'packages/shared'])
    );
  });

  it('OPS-2: apps whose graph includes the changed workspace get a production build', () => {
    expect(run('apps/web/src/app/page.tsx').buildApps).toEqual(['web']);
    expect(run('apps/admin/src/x.ts').buildApps).toEqual(['admin']);
    // a shared package touches every app that has a deploy build
    expect(run('packages/ui/src/Button.tsx').buildApps).toEqual(
      expect.arrayContaining(['web', 'admin'])
    );
    expect(run('packages/shared/src/x.ts').buildApps).toEqual(
      expect.arrayContaining(['web', 'admin', 'orders', 'marketing', 'docs', 'help'])
    );
    // a root config can change any build
    expect(run('package-lock.json').buildApps.length).toBeGreaterThanOrEqual(4); // 6 before N-17 removed the deploy + smoke Postgres services
  });

  it('OPS-2: docs, api-only and test-only changes build no app', () => {
    expect(run('docs/ebda/ci.md').buildApps).toEqual([]);
    expect(run('apps/api/src/x.ts').buildApps).toEqual([]);
    expect(run('tests/unit/x.test.ts').buildApps).toEqual([]);
  });

  it('docs-only changes select nothing', () => {
    const r = run('docs/ebda/ci.md', 'README.md', 'apps/web/README.md');
    expect(r.code).toBe(false);
    expect(r.lint).toEqual([]);
    expect(r.unit).toEqual([]);
    expect(r.workers).toEqual([]);
  });

  it('an app change selects that app and its unit path', () => {
    const r = run('apps/admin/src/app/page.tsx');
    expect(r.all).toBe(false);
    expect(r.workspaces).toEqual(['apps/admin']);
    expect(r.lint).toEqual(['-w apps/admin']);
    expect(r.typecheck).toEqual(['apps/admin/tsconfig.json']);
    expect(r.unit).toEqual(['tests/unit', 'apps/admin/src']);
    // Ordinary source changes do not dry-run the Worker (~9 billed minutes)...
    expect(r.workers).toEqual([]);
  });

  it('...but a change to the Worker own config does', () => {
    expect(run('apps/admin/wrangler.jsonc').workers).toEqual(['admin']);
    expect(run('apps/orders/package.json').workers).toEqual(['orders']);
    expect(run('apps/web/sentry-worker-entry.ts').workers).toEqual(['web']);
    // the two HTML edge caches and their build partition (EDGE-BUILD-1, #503) are bundled by that entry
    expect(run('apps/web/demo-edge-cache.ts').workers).toEqual(['web']);
    expect(run('apps/web/store-edge-cache.ts').workers).toEqual(['web']);
    expect(run('apps/web/edge-build-id.ts').workers).toEqual(['web']);
    expect(run('apps/status/src/index.ts').workers).toEqual(['status']);
    expect(run('apps/accounts/src/app.ts').workers).toEqual(['accounts']);
    // marketing (static export, cheap) dry-runs on any page-weight change, so its budget fails the PR that grows it
    expect(run('apps/marketing/src/app/chrome.css').workers).toEqual(['marketing']);
    expect(run('apps/marketing/src/components/LegalPage.tsx').workers).toEqual(['marketing']);
    expect(run('scripts/ci/marketing-perf-budget.json').workers).toEqual(['marketing']);
    // the API is a Worker app since SP4 Stage 1 (apps/api/wrangler.jsonc)
    expect(run('apps/api/wrangler.jsonc').workers).toEqual(['api']);
    // root manifest / cf-* scripts hit every Worker app
    expect(run('package-lock.json').workers.sort()).toEqual([
      'accounts',
      'admin',
      'api',
      'marketing',
      'orders',
      'status',
      'web',
    ]);
  });

  it('every local module the web Worker entry bundles selects the web Worker checks', () => {
    // The custom entry is compiled by wrangler outside the Next build, so a change to anything it imports moves the
    // Worker bundle. Walk its relative imports (the OpenNext output is generated, not source) so a module added to
    // the entry without a line in WORKER_ENTRY fails here instead of silently skipping the dry run.
    const web = path.join(ROOT, 'apps/web');
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(path.join(web, file), 'utf8');
      for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
        if (m[1].startsWith('./.open-next/')) continue;
        walk(path.relative(web, path.resolve(web, path.dirname(file), m[1])) + '.ts');
      }
    };
    walk('sentry-worker-entry.ts');
    expect(seen.size).toBeGreaterThanOrEqual(8);
    for (const f of seen) expect(run(`apps/web/${f}`).workers, f).toEqual(['web']);
    // tests next to those modules and ordinary app source stay out
    expect(run('apps/web/demo-edge-cache.test.ts').workers).toEqual([]);
    expect(run('apps/web/src/lib/api.ts').workers).toEqual([]);
  });

  it.each([
    'packages/database/prisma/schema.prisma',
    'packages/database/prisma/migrations/20261110000000_x/migration.sql',
  ])(
    '%s always puts packages/cf-schema in the unit lane (the generated CF schema derives from it)',
    f => {
      expect(run(f).unit).toContain('packages/cf-schema');
    }
  );

  it('an unrelated app change does not drag the cf-schema tests in', () => {
    expect(run('apps/marketing/src/page.tsx').unit).not.toContain('packages/cf-schema');
  });

  it('a package change also selects its dependents', () => {
    const r = run('packages/ui/src/button.tsx');
    expect(r.workspaces).toEqual(expect.arrayContaining(['packages/ui', 'apps/admin', 'apps/web']));
  });

  it.each([
    'packages/shared/src/x.ts',
    'packages/database/prisma/schema.prisma',
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'vitest.config.ts',
  ])('%s selects every workspace', f => {
    const r = run(f);
    expect(r.all).toBe(true);
    expect(r.workspaces).toEqual(ws.map((w: { dir: string }) => w.dir));
  });

  it('tests/, scripts/ and .github/ run the unit tiers without touching per-app lint', () => {
    for (const f of ['tests/unit/x.test.ts', 'scripts/foo.mjs', '.github/workflows/ci.yml']) {
      const r = run(f);
      expect(r.all, f).toBe(false);
      expect(r.lint, f).toEqual([]);
      expect(r.unit, f).toContain('tests/unit');
      expect(r.unit, f).toContain('packages/shared/src');
    }
  });

  it('the search eval (tests/search-eval) is typechecked when it or the API it imports changes', () => {
    const EVAL = 'tests/search-eval/tsconfig.json';
    expect(run('apps/api/src/services/product-search.service.ts').typecheck).toContain(EVAL);
    expect(run('tests/search-eval/run.ts').typecheck).toEqual([EVAL]);
    expect(run('packages/database/prisma/schema.prisma').typecheck).toContain(EVAL);
    expect(run('apps/admin/src/app/page.tsx').typecheck).not.toContain(EVAL);
    // and the full lane's `npm run typecheck`
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.typecheck).toContain(`tsc --noEmit -p ${EVAL}`);
  });

  it('only lists Worker apps that have a wrangler config', () => {
    const r = run('package.json');
    expect(r.workers.length).toBeGreaterThan(0);
    expect(r.workers).not.toContain('docs');
    expect(r.workers).not.toContain('help');
    for (const w of r.workers as string[]) {
      const entry = ws.find((x: { dir: string }) => x.dir === `apps/${w}`);
      expect(entry.hasWrangler, w).toBe(true);
    }
  });
});

/**
 * Every Postgres that runs our migrations is the SAME image, and its major is production's (Neon
 * 17.11, measured 2026-10-16; Ruling SEARCH-T9-4). The migrations need the `vector` extension, so a
 * plain `postgres:` image fails `CREATE EXTENSION vector`, and a different major hides PG17-only
 * behaviour (maintenance-op search_path, pg_stat_statements 1.11 columns) until the prod migrate.
 */
describe('postgres image parity', () => {
  const PINNED = 'pgvector/pgvector:0.8.0-pg17';
  const FILES = [
    '.github/workflows/ci.yml',
    // cf-api-deploy.yml has no Postgres service any more (NEON-ZERO N-17).
    'docker-compose.yml',
    'docker/docker-compose.yml',
    'scripts/buy-flow-parity/run.mjs',
  ];
  // Any postgres / pgvector image reference: `image: x` / `image: 'x'` (tag optional, so a bare
  // `postgres` is caught), or a quoted `name:tag` string (container run args). `postgresql://`
  // URLs and a bare 'postgres' label are not images.
  const IMG = String.raw`(?:docker\.io\/)?(?:library\/)?(?:postgres|pgvector\/pgvector)`;
  const IMAGE_RE = new RegExp(
    String.raw`image:\s*['"]?(${IMG}(?::[^\s'"]+)?)(?=['"\s]|$)|['"](${IMG}:[^\s'"]+)['"]`,
    'gm'
  );

  for (const f of FILES) {
    it(`${f} runs only ${PINNED}`, () => {
      const text = readFileSync(path.join(ROOT, f), 'utf8');
      const refs = [...text.matchAll(IMAGE_RE)].map(m =>
        (m[1] ?? m[2]).replace(/^docker\.io\//, '')
      );
      expect(refs.length, `${f}: no postgres image found`).toBeGreaterThan(0);
      expect(refs.filter(r => r !== PINNED)).toEqual([]);
    });
  }
});

describe('OPS-5: a failed deploy reaches a human', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const deploys = readdirSync(dir).filter(f => /^cf-.*-deploy\.yml$/.test(f));
  it('finds the deploy workflows', () => expect(deploys.length).toBeGreaterThanOrEqual(9));
  it.each(deploys)('%s has a notify-failure job wired to the Telegram secrets', f => {
    const raw = readFileSync(path.join(dir, f), 'utf8');
    expect(raw).toMatch(/\n {2}notify-failure:/);
    expect(raw).toContain("needs.deploy.result == 'failure'");
    expect(raw).toContain('secrets.TELEGRAM_BOT_TOKEN');
    expect(raw).toContain('secrets.TELEGRAM_ALERT_CHAT_ID');
  });
});

describe('service containers leave no anonymous docker volumes (guest disk leak 2026-10-26)', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const files = readdirSync(dir).filter(f => /\.ya?ml$/.test(f));
  for (const f of files) {
    const raw = readFileSync(path.join(dir, f), 'utf8');
    const blocks = [
      ...raw.matchAll(
        /image: (pgvector\/\S+|postgres\S*|redis\S*)\n([\s\S]*?)(?=\n\s{4,6}\w[\w-]*:|\n\s{2}\w)/g
      ),
    ];
    for (const b of blocks) {
      const image = b[1];
      const opts =
        /options: >-\n((?:\s+--.*\n?)+)/.exec(raw.slice(b.index!, b.index! + 1200))?.[1] ?? '';
      it(`${f}: ${image} mounts its data dir on tmpfs`, () => {
        if (image.startsWith('redis')) expect(opts).toContain('--tmpfs /data');
        else expect(opts).toContain('--tmpfs /var/lib/postgresql/data');
      });
    }
  }
  it('finds the service containers', () => {
    const all = files.map(f => readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(
      [...all.matchAll(/--tmpfs \/var\/lib\/postgresql\/data/g)].length
    ).toBeGreaterThanOrEqual(2); // 6 before N-17 removed the deploy + smoke + RLS Postgres services (integration + e2e remain)
  });
});

describe('app-build is one-at-a-time and heavy-lane (guest memory)', () => {
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const job = ci.slice(ci.indexOf('\n  app-build:\n'), ci.indexOf('\n  app-builds:\n'));
  it('runs one production build at a time', () => expect(job).toMatch(/max-parallel: 1/));
  it('is not a light-lane job id (umbra DefaultLightJobs globs)', () => {
    const light = [
      'notify-failure*',
      'notify*',
      'changes',
      'detect-changes*',
      'guards',
      'repo-guards*',
      'scan',
      'gitleaks*',
      'secret-scan*',
      'client-secret-scan*',
      'blast-radius*',
    ];
    const glob = (g: string) => new RegExp('^' + g.replace(/\*/g, '.*') + '$');
    expect(light.some(g => glob(g).test('app-build'))).toBe(false);
  });
});
