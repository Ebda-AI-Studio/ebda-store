import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// TOCTOU hardening (security review): the migration scripts never write SQL to a predictable temp path.
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/cf');
const files = [
  ...fs.readdirSync(dir),
  ...fs.readdirSync(path.join(dir, 'lib')).map(f => `lib/${f}`),
].filter(f => f.endsWith('.mjs'));

describe('scripts/cf temp files', () => {
  it('only lib/d1.mjs touches the temp dir, and it uses mkdtemp + an exclusive 0600 file', () => {
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (f === 'lib/d1.mjs') {
        expect(src).toMatch(/mkdtempSync\(/);
        expect(src).toMatch(/flag: 'wx'/);
        expect(src).toMatch(/mode: 0o600/);
        expect(src).toMatch(/recursive: true/);
      } else {
        expect(src, f).not.toMatch(/tmpdir\(\)/);
        expect(src, f).not.toMatch(/['"`]\/tmp\//);
      }
    }
  });
});
