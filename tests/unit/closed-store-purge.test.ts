/**
 * Ruling NZ-D15B (plan N-24): the closed-store purge rules, driven through in-memory ports. The wipe is irreversible, so what is
 * proven here is everything that must stop it: not yet due, no notice, a failed or corrupt export, dry run, a flag without the date.
 */
import { describe, expect, it } from 'vitest';
import {
  PURGE_DRY_RUN_UNTIL,
  PURGE_NOTICE_DAYS,
  ledgerForClosure,
  purgeDueAt,
  purgeIsLive,
  purgeOneClosedStore,
  runClosedStorePurge,
  type ArchiveManifest,
  type ClosedStore,
  type PurgeLedger,
  type PurgePorts,
} from '../../apps/api/src/lib/closed-store-purge';

const DAY = 86_400_000;
const NOW = Date.UTC(2034, 5, 1); // far past the dry-run date
const yearsBefore = (n: number, from = NOW) => {
  const d = new Date(from);
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.getTime();
};

function harness(o: {
  store?: Partial<ClosedStore>;
  fiscal?: { count: number; lastIssuedAt: number | null };
  platformLast?: number | null;
  ledger?: PurgeLedger;
  readBack?: (m: ArchiveManifest) => { rows: number; sha256: string } | null;
  exportRows?: number;
  contact?: 'sent' | 'no_contact';
  wipeThrows?: boolean;
  proofsThrow?: boolean;
}) {
  const calls: string[] = [];
  const alerts: string[] = [];
  const ledger: PurgeLedger = { ...(o.ledger ?? {}) };
  const store: ClosedStore = { storeId: 's1', closedAt: yearsBefore(8), ...o.store };
  const fiscal = o.fiscal ?? { count: 3, lastIssuedAt: yearsBefore(8) };
  const manifest: ArchiveManifest = {
    key: 'closed-store-archive/s1/fiscal.ndjson',
    rows: o.exportRows ?? fiscal.count,
    sha256: 'abc',
  };
  const ports: PurgePorts = {
    listClosed: async () => [store],
    fiscalSummary: async () => fiscal,
    platformRecordsLastAt: async () => o.platformLast ?? null,
    ledger: {
      get: async () => ledger,
      put: async (_s, patch) => {
        calls.push(`ledger:${Object.keys(patch).join('+')}`);
        Object.assign(ledger, patch);
      },
    },
    notifyOwner: async () => (calls.push('notify'), o.contact ?? 'sent'),
    exportFiscal: async () => (calls.push('export'), manifest),
    readBack: async () => (
      calls.push('readBack'),
      o.readBack ? o.readBack(manifest) : { rows: manifest.rows, sha256: manifest.sha256 }
    ),
    wipe: async (_id, expect_) => {
      calls.push(`wipe:${expect_.fiscalDocuments}${expect_.resume ? ':resume' : ''}`);
      if (o.wipeThrows) throw new Error('do refused');
    },
    deleteProofFiles: async () => {
      calls.push('proofs');
      if (o.proofsThrow) throw new Error('r2 delete failed');
    },
    deleteDirectory: async () => void calls.push('deleteDirectory'),
    alert: async (t, b) => void alerts.push(`${t} | ${b}`),
    log: () => {},
  };
  return { ports, store, calls, alerts, ledger };
}
const run = (h: ReturnType<typeof harness>, now = NOW, live = true) =>
  purgeOneClosedStore(h.ports, h.store, now, live);
const READY: PurgeLedger = { noticeAt: NOW - (PURGE_NOTICE_DAYS + 1) * DAY, noticeOutcome: 'sent' };

describe('eligibility clock', () => {
  it('is 7 years after the LAST fiscal document, 90 days after closure when there is none', () => {
    const closed = Date.UTC(2030, 0, 1);
    expect(purgeDueAt({ storeId: 's', closedAt: closed }, { count: 0, lastIssuedAt: null })).toBe(
      closed + 90 * DAY
    );
    expect(
      purgeDueAt(
        { storeId: 's', closedAt: closed },
        { count: 2, lastIssuedAt: Date.UTC(2028, 2, 5) }
      )
    ).toBe(Date.UTC(2035, 2, 5));
  });
  it('a store with fiscal documents is not due before 7 years, even long after closure', async () => {
    const h = harness({
      fiscal: { count: 2, lastIssuedAt: yearsBefore(5) },
      store: { closedAt: yearsBefore(6) },
    });
    expect((await run(h)).outcome).toBe('not_due');
    expect(h.calls).toEqual([]);
  });
});

describe('notice before the wipe', () => {
  it('a due store with no notice gets one and is NOT wiped on the same run', async () => {
    const h = harness({});
    expect((await run(h)).outcome).toBe('notice_sent');
    expect(h.calls).toEqual(['notify', 'ledger:noticeAt+noticeOutcome']);
    expect(h.ledger.noticeAt).toBe(NOW);
  });
  it('a store with no contact is recorded as such and still waits the full window', async () => {
    const h = harness({ contact: 'no_contact' });
    await run(h);
    expect(h.ledger.noticeOutcome).toBe('no_contact');
    expect((await run(h, NOW + 5 * DAY)).outcome).toBe('waiting_notice');
    expect(h.calls.filter(c => c.startsWith('wipe'))).toEqual([]);
  });
  it('is wiped only once the notice is NOTICE_DAYS old', async () => {
    const early = harness({
      ledger: { noticeAt: NOW - (PURGE_NOTICE_DAYS - 1) * DAY, noticeOutcome: 'sent' },
    });
    expect((await run(early)).outcome).toBe('waiting_notice');
    const ready = harness({ ledger: READY });
    expect((await run(ready)).outcome).toBe('purged');
  });
});

describe('export, verification, wipe', () => {
  it('exports, reads back, wipes with the verified row count, then deletes the directory, in that order', async () => {
    const h = harness({ ledger: READY });
    expect(await run(h)).toEqual({ storeId: 's1', outcome: 'purged' });
    expect(h.calls).toEqual([
      'export',
      'ledger:archive',
      'readBack',
      'ledger:wipeStartedAt',
      'wipe:3',
      'ledger:wipedAt',
      'proofs',
      'deleteDirectory',
    ]);
  });
  it('a read-back that differs aborts, alerts, and deletes NOTHING', async () => {
    for (const bad of [
      () => ({ rows: 2, sha256: 'abc' }),
      () => ({ rows: 3, sha256: 'DIFFERENT' }),
      () => null,
    ]) {
      const h = harness({ ledger: READY, readBack: bad });
      const r = await run(h);
      expect(r.outcome).toBe('aborted');
      expect(h.calls.some(c => c.startsWith('wipe') || c === 'deleteDirectory')).toBe(false);
      expect(h.alerts).toHaveLength(1);
    }
  });
  it('an export with fewer rows than the store holds aborts before the read-back', async () => {
    const h = harness({ ledger: READY, exportRows: 2 });
    expect((await run(h)).outcome).toBe('aborted');
    expect(h.calls).toEqual(['export', 'ledger:archive']);
  });
  it('a wipe the DO refuses aborts with an alert and leaves the directory row', async () => {
    const h = harness({ ledger: READY, wipeThrows: true });
    expect((await run(h)).outcome).toBe('aborted');
    expect(h.calls).not.toContain('deleteDirectory');
    expect(h.alerts[0]).toMatch(/do refused/);
  });
  it('a store that never issued a fiscal document is purged 90 days after closure with an empty archive', async () => {
    const h = harness({
      ledger: READY,
      fiscal: { count: 0, lastIssuedAt: null },
      store: { closedAt: NOW - 120 * DAY },
    });
    expect((await run(h)).outcome).toBe('purged');
    expect(h.calls).toContain('wipe:0');
  });
  it('resumes a wiped store whose directory delete failed: only the directory step runs', async () => {
    const h = harness({ ledger: { ...READY, wipedAt: NOW - DAY } });
    expect((await run(h)).outcome).toBe('purged');
    expect(h.calls).toEqual(['proofs', 'deleteDirectory']);
  });
});

describe('dry run (the default for the first 30 days)', () => {
  it('runs the export and the verification but never wipes', async () => {
    const h = harness({ ledger: READY });
    expect((await run(h, NOW, false)).outcome).toBe('dry_run_verified');
    expect(h.calls).toEqual(['export', 'ledger:archive', 'readBack']);
  });
  it('a corrupt export is still caught in a dry run', async () => {
    const h = harness({ ledger: READY, readBack: () => ({ rows: 1, sha256: 'x' }) });
    expect((await run(h, NOW, false)).outcome).toBe('aborted');
  });
  it('live needs the flag AND a date on or after the dry-run end', () => {
    expect(purgeIsLive({}, NOW)).toBe(false);
    expect(purgeIsLive({ CLOSED_STORE_PURGE_LIVE: 'true' }, PURGE_DRY_RUN_UNTIL - 1)).toBe(false);
    expect(purgeIsLive({ CLOSED_STORE_PURGE_LIVE: 'yes' }, NOW)).toBe(false);
    expect(purgeIsLive({ CLOSED_STORE_PURGE_LIVE: 'true' }, PURGE_DRY_RUN_UNTIL)).toBe(true);
  });
});

describe('the run', () => {
  it('one store failing never stops the next', async () => {
    const calls: string[] = [];
    const ok = harness({ ledger: READY });
    const stores: ClosedStore[] = [
      { storeId: 'bad', closedAt: yearsBefore(8) },
      { storeId: 'good', closedAt: yearsBefore(8) },
    ];
    const ports: PurgePorts = {
      ...ok.ports,
      listClosed: async () => stores,
      fiscalSummary: async id => {
        if (id === 'bad') throw new Error('boom');
        return { count: 3, lastIssuedAt: yearsBefore(8) };
      },
      wipe: async id => void calls.push(`wipe:${id}`),
    };
    const res = await runClosedStorePurge(ports, { now: NOW, live: true });
    expect(res.map(r => [r.storeId, r.outcome])).toEqual([
      ['bad', 'aborted'],
      ['good', 'purged'],
    ]);
    expect(calls).toEqual(['wipe:good']);
  });
});

describe("the clock counts Ebda's own billing records too (review of #1109)", () => {
  it('a store with no fiscal document but a recent invoice / payment proof is NOT purged 90 days after closure', async () => {
    const closed = NOW - 120 * DAY;
    const h = harness({
      ledger: READY,
      fiscal: { count: 0, lastIssuedAt: null },
      store: { closedAt: closed },
      platformLast: NOW - 100 * DAY,
    });
    expect((await run(h)).outcome).toBe('not_due');
    expect(h.calls).toEqual([]);
  });
  it('due = 7 years after the LATER of the last fiscal document and the last platform record', () => {
    const s = { storeId: 's', closedAt: Date.UTC(2030, 0, 1) };
    const fiscalAt = Date.UTC(2028, 0, 1);
    const platformAt = Date.UTC(2031, 5, 1);
    expect(purgeDueAt(s, { count: 1, lastIssuedAt: fiscalAt }, platformAt)).toBe(
      Date.UTC(2038, 5, 1)
    );
    expect(purgeDueAt(s, { count: 1, lastIssuedAt: fiscalAt }, Date.UTC(2027, 0, 1))).toBe(
      Date.UTC(2035, 0, 1)
    );
    expect(purgeDueAt(s, { count: 0, lastIssuedAt: null }, platformAt)).toBe(Date.UTC(2038, 5, 1));
  });
});

describe('crash mid-wipe', () => {
  it('writes wipeStartedAt BEFORE the wipe (a crash between the two is resumable)', async () => {
    const h = harness({ ledger: READY });
    await run(h);
    expect(h.calls.indexOf('ledger:wipeStartedAt')).toBeGreaterThan(-1);
    expect(h.calls.indexOf('ledger:wipeStartedAt')).toBeLessThan(h.calls.indexOf('wipe:3'));
  });
  it('a run that finds wipeStartedAt resumes at the wipe (resume flag, verified row count), then the directory, without re-exporting', async () => {
    const h = harness({
      ledger: { ...READY, wipeStartedAt: NOW - DAY, archive: { key: 'k', rows: 3, sha256: 'abc' } },
    });
    expect((await run(h)).outcome).toBe('purged');
    expect(h.calls).toEqual(['wipe:3:resume', 'ledger:wipedAt', 'proofs', 'deleteDirectory']);
  });
  it('a wipe started but the DO refuses (not empty, not closed) aborts with an alert and leaves the directory', async () => {
    const h = harness({
      ledger: { ...READY, wipeStartedAt: NOW - DAY, archive: { key: 'k', rows: 3, sha256: 'abc' } },
      wipeThrows: true,
    });
    expect((await run(h)).outcome).toBe('aborted');
    expect(h.calls).not.toContain('deleteDirectory');
  });
});

describe('one ledger per closure', () => {
  const closure = { storeId: 's1', closedAt: 1_000 };
  it('a ledger written for another closure of the same store id is ignored', () => {
    const old: PurgeLedger = {
      closedAt: 500,
      noticeAt: 1,
      noticeOutcome: 'sent',
      wipedAt: 2,
      archive: { key: 'k', rows: 9, sha256: 'x' },
    };
    expect(ledgerForClosure(old, closure)).toEqual({});
    expect(ledgerForClosure({ ...old, closedAt: 1_000 }, closure)).toMatchObject({ wipedAt: 2 });
    expect(ledgerForClosure(null, closure)).toEqual({});
    expect(ledgerForClosure({ noticeAt: 1 }, closure)).toEqual({}); // a ledger with no closure is not trusted either
  });
});

describe('payment-proof files go BEFORE the tombstone clears their pointers', () => {
  it('the proof objects are deleted after the wipe and before the directory step, in live mode only', async () => {
    const live = harness({ ledger: READY });
    await run(live);
    expect(live.calls.indexOf('proofs')).toBeGreaterThan(live.calls.indexOf('ledger:wipedAt'));
    expect(live.calls.indexOf('proofs')).toBeLessThan(live.calls.indexOf('deleteDirectory'));
    const dry = harness({ ledger: READY });
    await run(dry, NOW, false);
    expect(dry.calls).not.toContain('proofs');
  });
  it('a failed object delete aborts with a P1 and the tombstone does NOT run (the pointers are still there to retry)', async () => {
    const h = harness({ ledger: READY, proofsThrow: true });
    const r = await run(h);
    expect(r.outcome).toBe('aborted');
    expect(h.calls).not.toContain('deleteDirectory');
    expect(h.alerts[0]).toMatch(/r2 delete failed/);
  });
  it('the next run (wiped marker set) retries the proof files, then tombstones', async () => {
    const h = harness({ ledger: { ...READY, wipedAt: NOW - DAY } });
    expect((await run(h)).outcome).toBe('purged');
    expect(h.calls).toEqual(['proofs', 'deleteDirectory']);
  });
});
