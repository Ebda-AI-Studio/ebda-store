/**
 * G19: every path that moves a trust request out of `open` stamps `decided_at` (the super-admin queue shows it), and the
 * review read selects it. A rejection also keeps `rejected_at` (it starts the appeal cooldown).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@ebda/database', () => ({ prisma: {}, currentStoreId: () => 's1' }));

import {
  closeAppealsOnReactivation,
  closeGrantedRequests,
  decideTrustRequest,
  rejectAppeal,
} from '../../apps/api/src/services/trust-requests.service';

function fakeDb(row: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const selects: unknown[] = [];
  const db = {
    trustRequest: {
      findFirst: async (args: { select?: unknown }) => {
        selects.push(args.select);
        return row;
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { count: 1 };
      },
    },
  };
  return { db: db as never, updates, selects };
}

const open = { id: 'r1', kind: 'support', status: 'open', storeId: 's1', userId: 'u1' };

describe('decided_at is set on every decide path (G19)', () => {
  it('staff resolve', async () => {
    const f = fakeDb(open);
    await decideTrustRequest(f.db, 'r1', 'resolved');
    expect(f.updates[0].decidedAt).toBeInstanceOf(Date);
    expect(f.updates[0].rejectedAt).toBeUndefined();
  });
  it('staff reject keeps rejected_at and adds decided_at', async () => {
    const f = fakeDb(open);
    await decideTrustRequest(f.db, 'r1', 'rejected');
    expect(f.updates[0].decidedAt).toBeInstanceOf(Date);
    expect(f.updates[0].rejectedAt).toBeInstanceOf(Date);
  });
  it('appeal reject route', async () => {
    const f = fakeDb({ id: 'a1' });
    await rejectAppeal(f.db, 's1');
    expect(f.updates[0].decidedAt).toBeInstanceOf(Date);
    expect(f.updates[0].rejectedAt).toBeInstanceOf(Date);
  });
  it('reactivation closes the open appeal', async () => {
    const f = fakeDb({});
    await closeAppealsOnReactivation(f.db, 's1');
    expect(f.updates[0]).toMatchObject({ status: 'resolved' });
    expect(f.updates[0].decidedAt).toBeInstanceOf(Date);
  });
  it('a slug grant closes the open claims', async () => {
    const f = fakeDb({});
    await closeGrantedRequests(f.db as never, { slug: 'Nike' });
    expect(f.updates[0].decidedAt).toBeInstanceOf(Date);
  });
  it('the staff review read selects decidedAt', async () => {
    const f = fakeDb(open);
    await decideTrustRequest(f.db, 'r1', 'resolved');
    expect(f.selects[0]).toMatchObject({ decidedAt: true });
  });
});

describe('the column exists in D1 as its own numbered migration', () => {
  it('0013 adds decided_at once and 0012 is untouched by it', () => {
    const dir = path.resolve(__dirname, '../../packages/cf-schema/migrations/platform');
    expect(fs.readFileSync(path.join(dir, '0013_trust_requests_decided_at.sql'), 'utf8')).toContain(
      'ALTER TABLE "trust_requests" ADD COLUMN "decided_at" INTEGER'
    );
    expect(fs.readFileSync(path.join(dir, '0012_trust_requests.sql'), 'utf8')).not.toContain(
      'decided_at'
    );
  });
});
