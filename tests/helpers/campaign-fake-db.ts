/**
 * In-memory stand-in for the slice of Prisma the email-campaign code uses.
 *
 * It EVALUATES the `where` clauses it receives rather than returning canned
 * rows, so a test fails when the production query stops filtering the way it
 * should — which is what lets the consent filter and the idempotency guard be
 * mutation-tested (delete the predicate → the fake returns the extra rows →
 * the test goes red). Supported operators are exactly the ones the campaign
 * code uses: equality, `in`, `not`, `gte`, `mode: 'insensitive'` with `in`,
 * and top-level `OR`.
 */

type Row = Record<string, any>;

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (typeof cond === 'object' && cond !== null) {
    const c = cond as Record<string, unknown>;
    const insensitive = c.mode === 'insensitive';
    const norm = (v: unknown) =>
      insensitive && typeof v === 'string' ? v.toLowerCase() : (v as unknown);
    if ('in' in c) {
      const list = (c.in as unknown[]).map(norm);
      if (!list.includes(norm(actual))) return false;
    }
    if ('equals' in c && norm(actual) !== norm(c.equals)) return false;
    if ('not' in c) {
      if (c.not === null) {
        if (actual === null || actual === undefined) return false;
      } else if (actual === c.not) return false;
    }
    if ('lt' in c) {
      const l = c.lt as Date;
      if (!(actual instanceof Date) || actual.getTime() >= l.getTime()) return false;
    }
    if ('gte' in c) {
      const g = c.gte as Date;
      if (!(actual instanceof Date) || actual.getTime() < g.getTime()) return false;
    }
    return true;
  }
  return actual === cond;
}

/** Resolves a to-many relation field name to its related rows for one parent row. */
export type RelationResolvers = Record<string, (row: Row) => Row[]>;

export function matches(row: Row, where: Row | undefined, relations?: RelationResolvers): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Row[]).some(w => matches(row, w, relations))) return false;
      continue;
    }
    if (relations && key in relations && typeof cond === 'object' && cond !== null) {
      const related = relations[key](row);
      const c = cond as Row;
      if ('none' in c) {
        if (related.some(r => matches(r, c.none, relations))) return false;
        continue;
      }
      if ('some' in c) {
        if (!related.some(r => matches(r, c.some, relations))) return false;
        continue;
      }
      if ('every' in c) {
        if (!related.every(r => matches(r, c.every, relations))) return false;
        continue;
      }
    }
    if (!matchValue(row[key], cond)) return false;
  }
  return true;
}

let seq = 0;
export function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

export interface FakeDb {
  stores: Row[];
  campaigns: Row[];
  recipients: Row[];
  subscribers: Row[];
  customers: Row[];
  users?: Row[];
  /** Cart-recovery emails count against the same 24h send budget (sentInLast24h). */
  abandonedCarts?: Row[];
}

export function createFakePrisma(db: FakeDb) {
  const pick = (row: Row, select?: Row): Row => {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (k === 'subscriber' && v && typeof v === 'object') {
        const sub = db.subscribers.find(s => s.id === row.subscriberId);
        out.subscriber = sub ? pick(sub, (v as Row).select) : null;
      } else if (v) out[k] = row[k];
    }
    return out;
  };

  const table = (
    rows: () => Row[],
    unique?: (a: Row, b: Row) => boolean,
    relations?: RelationResolvers
  ) => ({
    findFirst: async ({ where, select }: { where?: Row; select?: Row } = {}) => {
      const r = rows().find(x => matches(x, where, relations));
      return r ? pick(r, select) : null;
    },
    findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
      const r = rows().find(x => matches(x, where, relations));
      return r ? pick(r, select) : null;
    },
    findMany: async ({ where, select }: { where?: Row; select?: Row } = {}) =>
      rows()
        .filter(x => matches(x, where, relations))
        .map(x => pick(x, select)),
    count: async ({ where }: { where?: Row } = {}) =>
      rows().filter(x => matches(x, where, relations)).length,
    // Single-column `groupBy({ by: [col], _count: { _all: true } })` only.
    groupBy: async ({ by, where }: { by: string[]; where?: Row }) => {
      const counts = new Map<unknown, number>();
      for (const x of rows().filter(r => matches(r, where, relations)))
        counts.set(x[by[0]], (counts.get(x[by[0]]) ?? 0) + 1);
      return [...counts].map(([k, n]) => ({ [by[0]]: k, _count: { _all: n } }));
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const hit = rows().filter(x => matches(x, where, relations));
      hit.forEach(x => Object.assign(x, data, { updatedAt: new Date() }));
      return { count: hit.length };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = rows().find(x => matches(x, where, relations));
      if (!r) throw new Error('P2025: record not found');
      Object.assign(r, data);
      return { ...r };
    },
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const d of data) {
        if (unique && rows().some(x => unique(x, d))) {
          if (skipDuplicates) continue;
          throw new Error('P2002: unique constraint');
        }
        rows().push({
          id: uuid(),
          status: 'queued',
          providerMessageId: null,
          error: null,
          sentAt: null,
          unsubscribedAt: null,
          createdAt: new Date(Date.now() + count),
          ...d,
        });
        count++;
      }
      return { count };
    },
    create: async ({ data, select }: { data: Row; select?: Row }) => {
      const row = { id: uuid(), createdAt: new Date(), updatedAt: new Date(), ...data };
      rows().push(row);
      return pick(row, select);
    },
    deleteMany: async ({ where }: { where?: Row }) => {
      const keep = rows().filter(x => !matches(x, where, relations));
      const n = rows().length - keep.length;
      rows().splice(0, rows().length, ...keep);
      return { count: n };
    },
  });

  return {
    store: table(() => db.stores),
    campaign: table(() => db.campaigns, undefined, {
      recipients: row => db.recipients.filter(r => r.campaignId === row.id),
    }),
    campaignRecipient: table(
      () => db.recipients,
      (a, b) => a.campaignId === b.campaignId && a.email === b.email
    ),
    newsletterSubscriber: table(() => db.subscribers),
    customer: table(() => db.customers),
    user: table(() => (db.users ??= [])),
    abandonedCart: table(() => (db.abandonedCarts ??= [])),
    // #1953: `audienceCount` (campaign.service.ts) is the one raw-SQL query
    // the campaign code makes — mirrors `buildCampaignAudience`'s exact JS
    // filter/dedupe (normalized non-empty email, active, not unsubscribed) so
    // the two never silently disagree on what "reachable" means.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (!sql.includes('FROM newsletter_subscribers') || !sql.includes('COUNT(DISTINCT')) {
        throw new Error(`FakeDb.$queryRaw: unsupported query: ${sql}`);
      }
      const storeId = values[0] as string;
      const seen = new Set<string>();
      for (const s of db.subscribers) {
        if (s.storeId !== storeId) continue;
        if (s.isActive !== true) continue;
        if (s.consentScope === 'cart_reminders') continue;
        if (s.unsubscribedAt !== null && s.unsubscribedAt !== undefined) continue;
        const email = String(s.email ?? '')
          .toLowerCase()
          .trim();
        if (!email.includes('@')) continue;
        seen.add(email);
      }
      return [{ count: BigInt(seen.size) }];
    },
  };
}

export const STORE_A = '11111111-1111-4111-8111-111111111111';
export const STORE_B = '22222222-2222-4222-8222-222222222222';

export function storeRow(id: string, extra: Row = {}): Row {
  return {
    id,
    name: 'Test Store',
    nameAr: 'متجر',
    logo: null,
    email: 'owner@store.test',
    phone: null,
    address: null,
    theme: null,
    settings: { defaultLanguage: 'en' },
    slug: 'test-store',
    domain: null,
    emailSenderLocalPart: null,
    emailDomainStatus: null,
    ...extra,
  };
}

export function subscriberRow(storeId: string, email: string, extra: Row = {}): Row {
  return {
    id: uuid(),
    storeId,
    email,
    language: null,
    isActive: true,
    unsubscribedAt: null,
    subscribedAt: new Date(),
    ...extra,
  };
}
