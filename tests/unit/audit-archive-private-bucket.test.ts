/**
 * Privacy: audit archives hold IPs and user ids. They must never be written to the PUBLIC uploads bucket
 * (`STORAGE_BUCKET`, served at media.<host>); only the private bucket / STORE_BACKUPS binding.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = join(__dirname, '../..');
const h = vi.hoisted(() => ({ binding: undefined as any, priv: [] as string[], privAvail: true }));
vi.mock('@api/cf/bindings', async orig => ({
  ...(await orig<object>()),
  cfBindings: () => (h.binding ? { STORE_BACKUPS: h.binding } : undefined),
}));
vi.mock('@api/services/storage.service', () => ({
  StorageService: {
    privateBucket: () => {
      if (!h.privAvail) throw new Error('not configured');
      return 'ebda-private';
    },
    putPrivateObject: async (key: string) => void h.priv.push(key),
  },
}));
vi.mock('@api/services/audit-retention-cf', () => ({}));
vi.mock('@api/lib/definer', () => ({ auditRetention: {} }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { createFunction: () => ({}) } }));

import { archivePut } from '@api/lib/inngest/functions/audit-log-archive';

afterEach(() => {
  h.binding = undefined;
  h.priv.length = 0;
  h.privAvail = true;
});

describe('audit-log-archive destination', () => {
  it('writes through the private STORE_BACKUPS binding when present', async () => {
    const puts: string[] = [];
    h.binding = { put: async (k: string) => void puts.push(k) };
    const put = await archivePut();
    await put!('audit-archive/x.jsonl', '{}\n');
    expect(puts).toEqual(['audit-archive/x.jsonl']);
    expect(h.priv).toEqual([]);
  });
  it('falls back to the private S3 bucket, never the public one', async () => {
    const put = await archivePut();
    await put!('audit-archive/y.jsonl', '{}\n');
    expect(h.priv).toEqual(['audit-archive/y.jsonl']);
  });
  it('skips (null) when no private destination exists', async () => {
    h.privAvail = false;
    expect(await archivePut()).toBeNull();
  });
});

describe('no job writes audit-archive/ or backup keys to the public bucket', () => {
  const files = execFileSync(
    'git',
    [
      'grep',
      '-lE',
      'audit-archive/|store-do-backups/|d1-backups/',
      '--',
      'apps/api/src',
      ':!*.test.*',
    ],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean);

  it('finds the archive writers', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  // storage.service.ts OWNS the buckets (its own private/public split is pinned by its tests); every other writer is checked.
  const writers = files.filter(f => !f.endsWith('services/storage.service.ts'));
  const code = (f: string) =>
    readFileSync(join(root, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  it.each(writers)('%s never touches the public bucket config', f => {
    expect(code(f)).not.toMatch(/STORAGE_BUCKET|storageBucket|StorageService\.upload(Multiple)?\(/);
  });
});

describe('expense receipts are merchant financial documents: private bucket only', () => {
  const code = (f: string) =>
    readFileSync(join(root, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  it('the upload route writes with putPrivate and never the public StorageService.upload', () => {
    const src = code('apps/api/src/routes/expenses.routes.ts');
    expect(src).toMatch(/StorageService\.putPrivate\(/);
    expect(src).not.toMatch(/StorageService\.upload(Multiple)?\(/);
  });
  it('a receipt reference only resolves inside its own store prefix', async () => {
    const { privateReceiptKey } = await import('@api/services/accounting/expense-ocr.service');
    expect(privateReceiptKey('private:stores/s1/receipts/a.jpg', 's1')).toBe(
      'stores/s1/receipts/a.jpg'
    );
    expect(privateReceiptKey('private:stores/s2/receipts/a.jpg', 's1')).toBeNull();
    expect(privateReceiptKey('private:stores/s1/../s2/a.jpg', 's1')).toBeNull();
    // other private files of the SAME store (payment proofs, tax documents) are not receipts
    expect(privateReceiptKey('private:stores/s1/instapay/a.jpg', 's1')).toBeNull();
    expect(privateReceiptKey('private:stores/s1/tax/a.pdf', 's1')).toBeNull();
    expect(privateReceiptKey('https://media.example/stores/s1/misc/a.jpg', 's1')).toBeNull();
  });
});
