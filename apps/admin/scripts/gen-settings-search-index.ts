/**
 * Regenerates src/lib/settings-search-index.generated.json from the settings registry and the
 * admin messages (ar + en). Run after editing settings-registry.ts or any registered label:
 *   npx tsx apps/admin/scripts/gen-settings-search-index.ts
 * tests/unit/settings-registry.test.ts fails while the committed file differs from this output.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTRY } from '../src/lib/settings-registry';
import { buildSearchIndex } from '../src/lib/settings-index-build';
import en from '../src/i18n/messages/en.json';
import ar from '../src/i18n/messages/ar.json';

const out = join(__dirname, '../src/lib/settings-search-index.generated.json');
writeFileSync(out, JSON.stringify(buildSearchIndex(REGISTRY, en, ar), null, 2) + '\n');
console.log(`wrote ${REGISTRY.length} entries -> ${out}`);
