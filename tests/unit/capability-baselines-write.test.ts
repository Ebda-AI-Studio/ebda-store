/**
 * Regenerates capabilities/baselines/*.json from the current violations. Only runs with CAPABILITY_WRITE_BASELINES=1:
 *   CAPABILITY_WRITE_BASELINES=1 npx vitest run tests/unit/capability-baselines-write.test.ts
 * Use it after FIXING offenders so the ids leave the baseline. A baseline may never grow in a PR (the pr-quality
 * job capability-ratchet fails it), so regenerating is only legitimate when the file got smaller.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { checkCoverage } from '../../packages/shared/src/foundation/capability-coverage';
import { checkHelp } from '../../packages/shared/src/foundation/help-article';
import { checkSelfServiceRoutes } from '../../packages/shared/src/foundation/self-service-routes';
import { checkModelBypass } from '../../packages/shared/src/foundation/smart-layer-bypass';
import { REPO_ROOT, readConfig, storeCodeFacts } from '../helpers/capability-facts';
import { helpArticles } from '../helpers/help-articles';
import { bypassFiles, idsOf, loadRegistry, type BaselineName } from '../helpers/capability-guard';

const write = process.env.CAPABILITY_WRITE_BASELINES === '1';
const save = (name: BaselineName, ids: string[]) =>
  writeFileSync(
    join(REPO_ROOT, 'capabilities/baselines', `${name}.json`),
    JSON.stringify({ ids: [...new Set(ids)].sort() }, null, 2) + '\n'
  );

describe.skipIf(!write)('write capability baselines', () => {
  it('writes registry, coverage, superadmin, help and bypass baselines', async () => {
    const cfg = readConfig();
    const { entries, violations } = loadRegistry(cfg);
    const facts = await storeCodeFacts(cfg);
    save('registry', idsOf(violations));
    save('coverage', idsOf(checkCoverage(facts, entries)));
    save('superadmin', idsOf(checkSelfServiceRoutes(facts, entries)));
    save('help', idsOf(checkHelp(entries, helpArticles(), cfg)));
    save('bypass', idsOf(checkModelBypass(bypassFiles(), cfg)));
  }, 180_000);
});
