import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const BAN = /gemini|google|openai|anthropic|claude|baidu|\bocr\b/i;
const admin = join(__dirname, '../../apps/admin/src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('catalogue import never names the model vendor to a merchant', () => {
  it('both locale blocks', () => {
    for (const l of ['en', 'ar']) {
      const j = JSON.parse(readFileSync(join(admin, `i18n/messages/${l}.json`), 'utf8'));
      expect(JSON.stringify(j.bulk.catalogImport), l).not.toMatch(BAN);
      expect(JSON.stringify(j.bulk.tabs.catalog), l).not.toMatch(BAN);
    }
  });
  it('the admin UI tree and the merchant help articles', () => {
    const files = [
      ...walk(join(admin, 'app/stores/[id]/bulk/catalog-import')).filter(f => !/\.test\./.test(f)),
      join(admin, 'app/stores/[id]/bulk/_components/CatalogImportPanel.tsx'),
    ];
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(BAN);
  });
});
