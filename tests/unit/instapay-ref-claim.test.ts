/**
 * Ruling INSTAPAY-DO-1 (security review): the cross-store InstaPay reference claim is bound to the receipt that made it. The
 * D1 double below runs the REAL statements on SQLite over the real `entity_index` migration, so a race is decided by the same
 * primary key D1 uses. A reference a live receipt holds is never freed by a failed, duplicate or unknown-outcome submit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCfBindings } from '../../apps/api/src/cf/bindings';
import {
  claimInstapayReference,
  releaseInstapayReference,
  scheduleClaimRelease,
  withClaimReleases,
} from '../../apps/api/src/lib/instapay-ref-claim';

const mig = fs.readFileSync(
  path.join(__dirname, '../../packages/cf-schema/migrations/platform/0001_init.sql'),
  'utf8'
);
const entityIndexDdl = /CREATE TABLE IF NOT EXISTS "entity_index"[\s\S]*?\n\);/.exec(mig)![0];

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(entityIndexDdl);
  const api = {
    prepare: (sql: string) => ({
      bind: (...v: unknown[]) => ({
        run: async () => ({
          meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) },
        }),
        first: async () => (db.prepare(sql).get(...(v as never[])) as never) ?? null,
      }),
    }),
  };
  return { api, rows: () => db.prepare('SELECT * FROM entity_index').all() as any[] };
}

let D: ReturnType<typeof d1>;
beforeEach(() => {
  D = d1();
  setCfBindings({ PLATFORM_DB: D.api } as never);
});
afterEach(() => setCfBindings(undefined as never));

const REF = '123456789012';

describe('the cross-store reference claim', () => {
  it('20 stores racing for one reference: exactly one claims it, 19 are taken', async () => {
    const r = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        claimInstapayReference(REF, `store-${i}`, `receipt-${i}`)
      )
    );
    expect(r.filter(x => x === 'claimed')).toHaveLength(1);
    expect(r.filter(x => x === 'taken')).toHaveLength(19);
    expect(D.rows()).toHaveLength(1);
  });

  it('two receipts of ONE store cannot both hold it; the holder sees its own claim on a retry', async () => {
    expect(await claimInstapayReference(REF, 's1', 'r1')).toBe('claimed');
    expect(await claimInstapayReference(REF, 's1', 'r2')).toBe('taken');
    expect(await claimInstapayReference(REF, 's1', 'r1')).toBe('ours');
  });

  it('a release by anyone but the holding receipt frees nothing; the holder frees it and the key can be claimed again', async () => {
    await claimInstapayReference(REF, 's1', 'r1');
    await releaseInstapayReference(REF, 's1', 'r2'); // another receipt of the store
    await releaseInstapayReference(REF, 's2', 'r1'); // another store, same receipt id
    expect(D.rows()).toHaveLength(1);
    expect(await claimInstapayReference(REF, 's2', 'x')).toBe('taken');
    await releaseInstapayReference(REF, 's1', 'r1');
    expect(D.rows()).toHaveLength(0);
    expect(await claimInstapayReference(REF, 's2', 'x')).toBe('claimed');
  });

  it('without a D1 binding there is nothing to claim and nothing to free', async () => {
    setCfBindings(undefined as never);
    expect(await claimInstapayReference(REF, 's1', 'r1')).toBe('unavailable');
    await expect(releaseInstapayReference(REF, 's1', 'r1')).resolves.toBeUndefined();
  });
});

// ---- the service: which failures may free a claim ---------------------------------------------------------------------
const money = vi.hoisted(() => ({ client: null as any }));
vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<typeof import('../../apps/api/src/lib/repo-factory')>()),
  storeMoney: async () => money.client,
}));
import { InstapayReceiptService } from '../../apps/api/src/services/payment-providers/instapay-receipt.service';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { fieldsFrom } from '../helpers/instapay-receipt-fixtures';

const row = (id: string) => ({
  id,
  status: 'draft',
  extractionStatus: 'pending',
  extracted: null,
  sha256: 's',
});
function client(submit: () => Promise<unknown>) {
  return {
    receiptGet: async ({ receiptId }: { receiptId: string }) => row(receiptId),
    receiptProof: async () => ({ submitted: 0, sameImage: 0 }),
    receiptSubmit: vi.fn(submit),
  };
}
const submit = (receiptId: string, reference: string) =>
  InstapayReceiptService.submit({
    storeId: 's1',
    receiptId,
    scope: { kind: 'order', orderId: 'o1' },
    fields: fieldsFrom('receipt-sent', { reference }),
    expectedAmountMinor: 1,
    expectedReceivers: [],
    notBefore: null,
  });

describe('InstapayReceiptService.submit on a DO store: when a claim may be freed', () => {
  it('a DUPLICATE_REFERENCE answer keeps the claim (another live receipt holds the key)', async () => {
    money.client = client(async () => {
      throw new AppError(409, 'DUPLICATE_REFERENCE', 'dup');
    });
    await expect(submit('r1', REF)).rejects.toMatchObject({ code: 'DUPLICATE_REFERENCE' });
    expect(D.rows()).toHaveLength(1);
  });

  it('a transport error (outcome unknown) keeps the claim; the retry of the same receipt sees it as its own', async () => {
    money.client = client(async () => {
      throw new Error('network reset');
    });
    await expect(submit('r1', REF)).rejects.toThrow('network reset');
    expect(D.rows()).toHaveLength(1);
    expect(await claimInstapayReference(REF, 's1', 'r1')).toBe('ours');
  });

  it('a rolled-back refusal (the section did not commit) frees only the claim this receipt made', async () => {
    money.client = client(async () => {
      throw new AppError(409, 'PROOF_PENDING_REVIEW', 'waiting');
    });
    await expect(submit('r1', REF)).rejects.toMatchObject({ code: 'PROOF_PENDING_REVIEW' });
    expect(D.rows()).toHaveLength(0);
  });

  it('a refusal never frees a claim ANOTHER receipt holds: the second receipt is refused before the DO is reached', async () => {
    await claimInstapayReference(REF, 's1', 'holder');
    money.client = client(async () => ({}));
    await expect(submit('r2', REF)).rejects.toMatchObject({ code: 'DUPLICATE_REFERENCE' });
    expect(money.client.receiptSubmit).not.toHaveBeenCalled();
    expect(D.rows()).toHaveLength(1);
    expect(D.rows()[0].claim_ref).toBe('holder');
  });
});

describe('release is queued, never immediate (a rolled-back void must leave the claim held)', () => {
  const ref = { referenceKey: REF, storeId: 's1', receiptId: 'r1' };
  it('without a withClaimReleases scope the release is refused outside production and the claim stays', async () => {
    await claimInstapayReference(REF, 's1', 'r1');
    expect(() => scheduleClaimRelease([ref])).toThrow(/release refused/);
    expect(D.rows()).toHaveLength(1);
  });
  it('in production the refusal is a P1 log and no release (fail closed), not a throw', async () => {
    await claimInstapayReference(REF, 's1', 'r1');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => scheduleClaimRelease([ref])).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(D.rows()).toHaveLength(1);
  });
  it('a throw inside the scope drops the queue; a clean exit releases', async () => {
    await claimInstapayReference(REF, 's1', 'r1');
    await expect(
      withClaimReleases(async () => {
        scheduleClaimRelease([ref]);
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');
    expect(D.rows()).toHaveLength(1);
    await withClaimReleases(async () => scheduleClaimRelease([ref]));
    expect(D.rows()).toHaveLength(0);
  });
});
