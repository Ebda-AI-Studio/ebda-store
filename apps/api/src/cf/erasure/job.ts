import type {
  ErasureEnv,
  ErasureSurface,
  ExportPart,
  R2BucketLike,
  Subject,
  SurfaceResult,
} from './types';

export class ErasureDisabledError extends Error {
  constructor() {
    super(
      'PDPL_CF_ERASURE_ENABLED is not "true": the Cloudflare erasure job is gated until the Store cuts over'
    );
  }
}
export const erasureEnabled = (env: Pick<ErasureEnv, 'PDPL_CF_ERASURE_ENABLED'>) =>
  env.PDPL_CF_ERASURE_ENABLED === 'true';

export interface LedgerEntry {
  requestId: string;
  kind: Subject['kind'];
  /** sha256 of the subject keys: the ledger proves an erasure happened without keeping the person. */
  subjectHash: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  surfaces: SurfaceResult[];
  errors: string[];
}

export const ledgerKey = (requestId: string) => `erasure-ledger/${requestId}.json`;
export const exportKey = (requestId: string, surface: string) =>
  `exports/${requestId}/${surface}.ndjson`;

async function sha256(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const subjectKeys = (s: Subject) =>
  s.kind === 'merchant' ? `m:${s.storeId}:${s.ownerUserId}` : `c:${s.buyerKey}:${s.userId ?? ''}`;

/**
 * Erase one subject across every surface. Never stops at the first failure (the others still run), and
 * a surface that reports `remaining > 0` fails the job: an erasure that left data behind is not done.
 * Idempotent per requestId: a finished ledger entry short-circuits a replay (queue redelivery).
 */
export async function runErasure(
  env: ErasureEnv,
  surfaces: ErasureSurface[],
  subject: Subject,
  deps: { alert?: (title: string, body: string) => Promise<unknown>; now?: () => Date } = {}
): Promise<LedgerEntry> {
  if (!erasureEnabled(env)) throw new ErasureDisabledError();
  const ledger = env.STORE_BACKUPS as R2BucketLike | undefined;
  if (!ledger) throw new Error('STORE_BACKUPS binding missing: no place to record the erasure');
  const prior = await ledger.get(ledgerKey(subject.requestId));
  if (prior) {
    const e = JSON.parse(await prior.text()) as LedgerEntry;
    if (e.status === 'done') return e;
  }
  const now = deps.now ?? (() => new Date());
  const entry: LedgerEntry = {
    requestId: subject.requestId,
    kind: subject.kind,
    subjectHash: await sha256(subjectKeys(subject)),
    startedAt: now().toISOString(),
    status: 'running',
    surfaces: [],
    errors: [],
  };
  await ledger.put(ledgerKey(entry.requestId), JSON.stringify(entry));
  // A MERCHANT erasure runs the StoreDO surface FIRST, as the gate (Ruling NZ-D17): the DO refuses while money is in flight, and a
  // refusal must stop the job BEFORE identity, media or customer-intelligence data is touched (no partial erasure).
  const ordered =
    subject.kind === 'merchant'
      ? [
          ...surfaces.filter(x => x.name === 'store-do'),
          ...surfaces.filter(x => x.name !== 'store-do'),
        ]
      : surfaces;
  for (const surface of ordered) {
    try {
      const r = await surface.eraseSubject(subject);
      entry.surfaces.push(r);
      if (r.remaining > 0)
        entry.errors.push(
          `${r.surface}: ${r.remaining} record(s) remain after erase${r.note ? ` (${r.note})` : ''}`
        );
    } catch (e) {
      entry.errors.push(`${surface.name}: ${(e as Error).message}`);
    }
    if (subject.kind === 'merchant' && surface.name === 'store-do' && entry.errors.length) {
      entry.errors.push('later surfaces not run: the store gate failed');
      break;
    }
  }
  entry.status = entry.errors.length ? 'failed' : 'done';
  entry.finishedAt = now().toISOString();
  await ledger.put(ledgerKey(entry.requestId), JSON.stringify(entry));
  if (entry.status === 'failed')
    await deps.alert?.(
      'PDPL erasure FAILED',
      JSON.stringify({ requestId: entry.requestId, errors: entry.errors }, null, 2)
    );
  return entry;
}

/** Export one subject; each surface's NDJSON goes to R2 under exports/<requestId>/ plus a manifest. */
export async function runExport(
  env: ErasureEnv,
  surfaces: ErasureSurface[],
  subject: Subject
): Promise<{
  requestId: string;
  parts: Array<Pick<ExportPart, 'surface' | 'records'> & { key: string }>;
}> {
  if (!erasureEnabled(env)) throw new ErasureDisabledError();
  const out = env.STORE_BACKUPS as R2BucketLike | undefined;
  if (!out) throw new Error('STORE_BACKUPS binding missing');
  const parts: Array<{ surface: string; records: number; key: string }> = [];
  for (const surface of surfaces) {
    const p = await surface.exportSubject(subject);
    const key = exportKey(subject.requestId, p.surface);
    await out.put(key, p.ndjson);
    parts.push({ surface: p.surface, records: p.records, key });
  }
  await out.put(
    `exports/${subject.requestId}/manifest.json`,
    JSON.stringify(
      {
        requestId: subject.requestId,
        kind: subject.kind,
        createdAt: new Date().toISOString(),
        parts,
      },
      null,
      2
    )
  );
  return { requestId: subject.requestId, parts };
}
