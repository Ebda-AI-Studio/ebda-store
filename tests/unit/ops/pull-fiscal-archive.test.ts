// Ruling FISCAL-ARCHIVE-1: the Mac pull keeps an independent, verified, never-rotated second copy of the fiscal archive.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM
import { pullFiscalArchive, FISCAL_PREFIX } from '../../../scripts/ops/pull-cf-backups.mjs';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function bucket(ids: string[], tamper: string[] = [], missing: string[] = []) {
  const m = new Map<string, Buffer>();
  for (const id of ids) {
    const data = Buffer.from(`DATA-${id}`);
    m.set(`${FISCAL_PREFIX}data/${id}.ndjson.gz`, tamper.includes(id) ? Buffer.from('EVIL') : data);
    m.set(
      `${FISCAL_PREFIX}manifests/${id}.json`,
      Buffer.from(JSON.stringify({ sha256: sha(data) }))
    );
    if (missing.includes(id)) m.delete(`${FISCAL_PREFIX}data/${id}.ndjson.gz`);
  }
  return {
    list: async (p: string) => [...m.keys()].filter(k => k.startsWith(p)),
    get: async (k: string) => m.get(k) ?? null,
  };
}
const tmp = () => mkdtempSync(path.join(tmpdir(), 'fa-pull-'));
const dataPath = (root: string, id: string) =>
  path.join(root, 'fiscal-archive/v1/data', `${id}.ndjson.gz`);

describe('pullFiscalArchive', () => {
  it('downloads every store archive after verifying its sha256 against its manifest; a second run downloads nothing', async () => {
    const root = tmp();
    const b = bucket(['a1', 'b2']);
    expect(await pullFiscalArchive({ ...b, root })).toMatchObject({
      stores: 2,
      downloaded: 2,
      bad: [],
    });
    expect(readFileSync(dataPath(root, 'a1'), 'utf8')).toBe('DATA-a1');
    expect(await pullFiscalArchive({ ...b, root })).toMatchObject({ downloaded: 0, bad: [] });
  });

  it('a checksum mismatch or a missing data object is reported (P1 by the caller) and never written or overwriting a good copy', async () => {
    const root = tmp();
    await pullFiscalArchive({ ...bucket(['a1']), root });
    const r = await pullFiscalArchive({
      ...bucket(['a1', 'bad', 'gone'], ['a1', 'bad'], ['gone']),
      root,
    });
    expect(r.bad).toHaveLength(3 - 1 + 0); // 'a1' still good locally (skipped), 'bad' + 'gone' reported
    expect(r.bad.join(' ')).toMatch(/bad.*differs/);
    expect(r.bad.join(' ')).toMatch(/gone.*missing/);
    expect(existsSync(dataPath(root, 'bad'))).toBe(false);
    expect(readFileSync(dataPath(root, 'a1'), 'utf8')).toBe('DATA-a1');
  });

  it('is never pruned: the rotation code only touches days/ and objects/, and this copy lives under fiscal-archive/', () => {
    const src = readFileSync(
      path.join(__dirname, '../../../scripts/ops/pull-cf-backups.mjs'),
      'utf8'
    );
    const prune = src.slice(src.indexOf('// retention: newest'), src.indexOf('orphans++'));
    expect(prune).not.toContain('fiscal-archive');
    const fn = src.slice(
      src.indexOf('export async function pullFiscalArchive'),
      src.indexOf('const keychain')
    );
    expect(fn).not.toMatch(/rmSync|unlinkSync/);
  });
});
