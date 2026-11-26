// Ruling FISCAL-ARCHIVE-1: the Mac pull keeps an independent, verified, never-rotated second copy of the fiscal archive.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const encPath = (root: string, id: string) =>
  path.join(root, 'fiscal-archive/v1/data', `${id}.ndjson.gz.age`);
const indexOf = (root: string) =>
  JSON.parse(readFileSync(path.join(root, 'fiscal-archive/v1/index.json'), 'utf8'));
// stand-in for `age -r <public recipient>`: output is not the plaintext
const encryptFile = (plain: string, out: string) =>
  writeFileSync(out, Buffer.concat([Buffer.from('AGE:'), readFileSync(plain).reverse()]));
const allFiles = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? allFiles(path.join(d, e.name)) : [path.join(d, e.name)]
  );
const plainTemps = () => readdirSync(tmpdir()).filter(f => f.startsWith('fa-plain-'));

describe('pullFiscalArchive', () => {
  it('stores ONLY an age file + an index with both checksums; no plaintext anywhere; second run downloads nothing', async () => {
    const root = tmp();
    const b = bucket(['a1', 'b2']);
    expect(await pullFiscalArchive({ ...b, root, encryptFile })).toMatchObject({
      stores: 2,
      downloaded: 2,
      bad: [],
    });
    const enc = readFileSync(encPath(root, 'a1'));
    expect(enc.toString()).not.toContain('DATA-a1');
    const idx = indexOf(root);
    expect(idx.a1).toMatchObject({ plainSha256: sha(Buffer.from('DATA-a1')), encSha256: sha(enc) });
    for (const f of allFiles(root)) expect(readFileSync(f).toString()).not.toContain('DATA-a1');
    expect(allFiles(root).some(f => f.endsWith('.ndjson.gz'))).toBe(false);
    expect(plainTemps()).toEqual([]);
    expect(await pullFiscalArchive({ ...b, root, encryptFile })).toMatchObject({
      downloaded: 0,
      bad: [],
    });
  });

  it('a failing encryptor leaves no plaintext temp file and no stored data (finally cleanup)', async () => {
    const root = tmp();
    await expect(
      pullFiscalArchive({
        ...bucket(['x1']),
        root,
        encryptFile: () => {
          throw new Error('age boom');
        },
      })
    ).rejects.toThrow('age boom');
    expect(plainTemps()).toEqual([]);
    expect(existsSync(encPath(root, 'x1'))).toBe(false);
  });

  it('refuses to run with no recipient (never a plaintext copy)', async () => {
    await expect(pullFiscalArchive({ ...bucket(['a1']), root: tmp() })).rejects.toThrow(
      /no age recipient/
    );
  });

  it('a tampered .age is detected on the next run', async () => {
    const root = tmp();
    const b = bucket(['a1']);
    await pullFiscalArchive({ ...b, root, encryptFile });
    writeFileSync(encPath(root, 'a1'), 'tampered');
    const r = await pullFiscalArchive({ ...b, root, encryptFile });
    expect(r.bad.join(' ')).toMatch(/a1.*tampered or corrupt/);
  });

  it('an R2 checksum mismatch or a missing data object is reported and never stored', async () => {
    const root = tmp();
    const r = await pullFiscalArchive({
      ...bucket(['bad', 'gone'], ['bad'], ['gone']),
      root,
      encryptFile,
    });
    expect(r.bad.join(' ')).toMatch(/bad.*differs/);
    expect(r.bad.join(' ')).toMatch(/gone.*missing/);
    expect(existsSync(encPath(root, 'bad'))).toBe(false);
  });

  it('keep-forever: the rotation never touches it and the function cannot delete a stored copy', () => {
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
    expect(fn.replace(/rmSync\(tmp[^)]*\)/, '')).not.toMatch(/rmSync|unlinkSync/);
  });
});
