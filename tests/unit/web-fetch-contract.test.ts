/**
 * Ruling WEB-COLD-2: the storefront's shared fetch cache is keyed by a DATA-CONTRACT hash computed at build time from
 * the files that define the shape of the API data it parses. A change to any of them must start a fresh cache namespace;
 * anything else must keep the warm cache. (The bake into the deployed config is pinned in cf-cache-bindings-assert.)
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONTRACT_PATHS,
  contractFiles,
  contractVersion,
  // @ts-expect-error plain .mjs script, no types
} from '../../scripts/ci/fetch-contract-version.mjs';

const ROOT = path.resolve(__dirname, '../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'fetch-contract-'));
for (const p of CONTRACT_PATHS as string[])
  cpSync(path.join(ROOT, p), path.join(scratch, p), { recursive: true });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('fetch-cache data contract version (WEB-COLD-2)', () => {
  it('every contract path exists in the repo and yields contract files', () => {
    for (const p of CONTRACT_PATHS as string[])
      expect(existsSync(path.join(ROOT, p)), p).toBe(true);
    const files: string[] = contractFiles(ROOT);
    expect(files).toContain('apps/web/src/lib/store-resolver.ts');
    expect(files.some(f => f.startsWith('packages/shared/src/types/'))).toBe(true);
    expect(files.some(f => /\.test\.|__tests__/.test(f))).toBe(false);
  });

  it('is 16 hex chars and stable for an unchanged contract (the cache carries over)', () => {
    const v = contractVersion(scratch);
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(contractVersion(scratch)).toBe(v);
    expect(v).toBe(contractVersion(ROOT)); // same bytes, other checkout -> same namespace
  });

  it('a change outside the contract (a test, an unrelated file) keeps the version', () => {
    const before = contractVersion(scratch);
    writeFileSync(path.join(scratch, 'packages/shared/src/types/x.test.ts'), 'it("x", () => {});');
    writeFileSync(path.join(scratch, 'README.md'), 'unrelated');
    expect(contractVersion(scratch)).toBe(before);
  });

  it.each(CONTRACT_PATHS as string[])('a change under %s starts a fresh namespace', p => {
    const before = contractVersion(scratch);
    const files: string[] = contractFiles(scratch, [p]);
    appendFileSync(path.join(scratch, files[0]), '\n// shape change\n');
    expect(contractVersion(scratch)).not.toBe(before);
  });

  it('a NEW contract file (a new response type) also starts a fresh namespace', () => {
    const before = contractVersion(scratch);
    writeFileSync(
      path.join(scratch, 'packages/shared/src/types/new-payload.ts'),
      'export type P = { a: string };'
    );
    expect(contractVersion(scratch)).not.toBe(before);
  });
});
