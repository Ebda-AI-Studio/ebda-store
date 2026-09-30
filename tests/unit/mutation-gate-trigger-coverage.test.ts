/**
 * The defence-mutation gate must actually RUN on the code it guards.
 *
 * `.github/workflows/mutation-testing.yml` triggers on a hand-written `paths:`
 * list, and `docs/security/defence-mutations.json` names the sources whose
 * guards that run deletes. The two are the same information written twice, so
 * they drift: add a defence pointing at a file no glob covers and the workflow
 * silently stops firing for it — the gate still passes every PR, having
 * measured nothing about the change in front of it.
 *
 * That is the failure this repo keeps re-learning: a gate's existence is not
 * evidence it ran. Rather than trusting the two lists to be maintained
 * together, this asserts it.
 *
 * If this fails, add the missing glob to the workflow — do not delete the
 * defence.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/** The `paths:` entries of the workflow's pull_request trigger. */
function triggerPaths(): string[] {
  const yml = readFileSync(path.join(ROOT, '.github/workflows/mutation-testing.yml'), 'utf8');
  const pr = yml.slice(yml.indexOf('  pull_request:'), yml.indexOf('  workflow_dispatch:'));
  return [...pr.matchAll(/^\s*-\s*'([^']+)'/gm)].map(m => m[1]);
}

/** Minimal glob match for the shapes this list actually uses. */
function globMatches(glob: string, file: string): boolean {
  const rx = new RegExp(
    '^' +
      glob
        .split('**')
        .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
        .join('.*') +
      '$'
  );
  return rx.test(file);
}

describe('defence-mutation gate triggers on everything it measures', () => {
  const paths = triggerPaths();

  it('the workflow declares a non-empty pull_request paths filter', () => {
    // An empty parse would make every assertion below vacuously fail-open.
    expect(paths.length).toBeGreaterThan(5);
  });

  it('every source named in the spec is covered by a trigger path', () => {
    const spec = JSON.parse(
      readFileSync(path.join(ROOT, 'docs/security/defence-mutations.json'), 'utf8')
    ) as { defences: Array<{ id: string; source: string }> };

    const uncovered = spec.defences
      .filter(d => !paths.some(g => globMatches(g, d.source)))
      .map(d => `${d.source}  (defence: ${d.id})`);

    expect(
      [...new Set(uncovered)],
      'these defended sources can change without the mutation gate running — add a glob to .github/workflows/mutation-testing.yml'
    ).toEqual([]);
  });

  it("every spec entry's TEST is covered by a trigger path too (issues 2175/2188)", () => {
    // --tier=all rests several verdicts on tests/integration/* files. A PR that
    // weakens the guarding test is as much a change to the defence as one
    // that edits its source — and used to match no glob at all.
    const spec = JSON.parse(
      readFileSync(path.join(ROOT, 'docs/security/defence-mutations.json'), 'utf8')
    ) as { defences: Array<{ id: string; test: string }> };

    const uncovered = spec.defences
      .filter(d => !paths.some(g => globMatches(g, d.test)))
      .map(d => `${d.test}  (defence: ${d.id})`);

    expect(
      [...new Set(uncovered)],
      'these guarding tests can change without the mutation gate running — add a glob to .github/workflows/mutation-testing.yml'
    ).toEqual([]);
  });

  it('the job provisioning comment names EVERY integration-tier defence (issues 2184/2187)', () => {
    // The Postgres-only services block is justified entry by entry. An
    // integration-tier defence added to the spec without being reasoned about
    // there is exactly how "the one integration-tier defence" went stale
    // while three ran.
    const spec = JSON.parse(
      readFileSync(path.join(ROOT, 'docs/security/defence-mutations.json'), 'utf8')
    ) as { defences: Array<{ id: string; tier?: string; test: string }> };
    const mut = readFileSync(path.join(ROOT, '.github/workflows/mutation-testing.yml'), 'utf8');
    const services = mut.slice(
      mut.indexOf('Postgres only, no Redis'),
      mut.indexOf('    services:')
    );
    expect(
      services.length,
      'the services justification comment moved — re-point this test'
    ).toBeGreaterThan(100);

    const integration = spec.defences.filter(d => d.tier === 'integration');
    expect(integration.length).toBeGreaterThan(0);
    for (const d of integration) {
      expect(
        services,
        `${d.id} is integration-tier but the services comment never reasons about it`
      ).toContain(d.id);
    }
    expect(mut, 'a stale singular "the one integration-tier" claim is back').not.toMatch(
      /the one integration-tier/
    );
  });

  it('covers the harness the run itself depends on', () => {
    // The runner, the spec, the record it diffs, and the vitest resolution it
    // executes through. A change to any of these changes what the gate
    // measures, so a PR touching only them must still run it.
    for (const f of [
      'scripts/defence-mutation-record.mjs',
      'docs/security/defence-mutations.json',
      'docs/security/defence-mutation-record.md',
      'vitest.stryker.config.ts',
      'vitest.shared.ts',
    ]) {
      expect(
        paths.some(g => globMatches(g, f)),
        `${f} is part of the harness but no trigger path covers it`
      ).toBe(true);
    }
  });

  it('the retry-0 unit gate runs the same scope as the CI unit job', () => {
    // ci.yml's Unit Tests job deliberately reaches past tests/unit into the
    // colocated __tests__ suites; its own comment records those being orphaned
    // twice. If the retry-0 gate is narrower, a masked flake in exactly those
    // files is what it fails to catch.
    const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const mut = readFileSync(path.join(ROOT, '.github/workflows/mutation-testing.yml'), 'utf8');

    const ciRun = ci.split('\n').find(l => l.includes('vitest run tests/unit'));
    expect(ciRun, "ci.yml's unit command moved — re-point this test").toBeTruthy();

    const ciScope = (ciRun as string)
      .split(/\s+/)
      .filter(t => /^(tests|packages|apps)\//.test(t))
      .sort();
    expect(ciScope.length).toBeGreaterThan(1);

    // Read the RUN COMMAND, not the whole file. Checking `mut.includes(dir)`
    // passed on the file as a whole because the trigger-paths block lists the
    // same directories, so narrowing the command left it green.
    const runIdx = mut.indexOf('vitest run --config');
    expect(runIdx, 'the retry-0 gate command moved — re-point this test').toBeGreaterThan(-1);
    const runCmd = mut.slice(runIdx, mut.indexOf('\n\n', runIdx));

    // Tokenize and compare by exact token, not `runCmd.includes(dir)`
    // substring containment (#1385): a future narrowing of ci.yml's command
    // from `apps/web` to `apps/web/src/lib` still satisfies
    // `'... apps/web/src/lib ...'.includes('apps/web')`, passing this test
    // while re-orphaning exactly the colocated tests ci.yml's own comment
    // records as having shipped outside the glob before. Strip the shell
    // line-continuation backslash before tokenizing.
    const runTokens = new Set(
      runCmd
        .split(/\s+/)
        .map(t => t.replace(/\\$/, ''))
        .filter(Boolean)
    );

    for (const dir of ciScope) {
      expect(
        runTokens.has(dir),
        `ci.yml runs unit tests over ${dir} but the retry-0 gate's command does not — masked flakes there go uncaught`
      ).toBe(true);
    }

    // Naming the directories is not enough, which is the trap this assertion
    // was written into and then failed to catch. Vitest positional arguments
    // are FILTERS against whatever `test.include` collected — they narrow that
    // set and can never widen it. Run under vitest.stryker.config.ts, whose
    // include is `tests/unit/**` only, the four extra paths match nothing: the
    // command listed 182 files' worth of directories and collected 159. So the
    // gate must run the config whose include actually spans the scope, with
    // retry forced off.
    expect(
      runCmd.includes('--config vitest.config.ts'),
      "the retry-0 gate must use ci.yml's config — the stryker config's include stops at tests/unit, so positional paths beyond it collect nothing"
    ).toBe(true);
    expect(
      runCmd.includes('--retry=0'),
      'the point of this gate is retry: 1 not masking order-dependent failures'
    ).toBe(true);

    // #1439: this step used to omit ci.yml's --maxWorkers=2 (vitest.config.ts
    // defaults to maxWorkers: 1), so it ran the full ~182-file scope single-
    // worker — roughly double ci.yml's own wall clock for the identical
    // scope — inside a job whose timeout was budgeted when this step was a
    // ~20s, 159-file stryker run. A worker-count drift here is invisible in
    // a diff review the same way the scope drift this test already guards
    // was, so it is asserted the same way.
    const ciWorkers = ciRun?.match(/--maxWorkers=\d+/)?.[0];
    expect(ciWorkers, "ci.yml's unit job dropped --maxWorkers — re-point this test").toBeTruthy();
    expect(
      runCmd.includes(ciWorkers as string),
      `ci.yml runs the identical unit scope with ${ciWorkers}, but the retry-0 gate does not — it can run single-worker and time out the job instead of surfacing a real result`
    ).toBe(true);

    // And pin the premise, so a future widening of the stryker include does not
    // silently make the reasoning above stale without anyone noticing.
    const stryker = readFileSync(path.join(ROOT, 'vitest.stryker.config.ts'), 'utf8');
    expect(
      stryker.includes("include: ['tests/unit/**"),
      'vitest.stryker.config.ts include changed — re-check whether the retry-0 gate can use it directly'
    ).toBe(true);
  });
});
