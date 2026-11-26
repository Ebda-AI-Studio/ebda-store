// Cloudflare-only additions that do not exist in schema.prisma. Everything here is deliberate and
// reviewed: the CI-1 capture fields (Customer Intelligence, register 2026-10-24, launch step 9), the
// buyer key of the WhatsApp contract, and the small infrastructure tables the new topology needs.
// Shapes mirror the parser's output so the one emitter handles them.

const f = (name, type, opts = {}) => ({
  name,
  type,
  list: false,
  optional: !!opts.optional,
  column: opts.column ?? name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`),
  kind: opts.kind ?? 'scalar',
  attrs: {
    ...(opts.default !== undefined ? { default: opts.default } : {}),
    ...(opts.id ? { id: true } : {}),
    ...(opts.enumValues ? { enumValues: opts.enumValues } : {}),
  },
  cfNote: opts.note,
  // A column added AFTER 0001 was applied to a live database: 0001 must not carry it (the migration `since` adds it, once).
  cfSince: opts.since,
});

// Normalised COD return reasons. The raw carrier text is always kept next to the code, so the closed
// set can be widened later without losing data (CI-1: "a COD return-reason code, raw plus normalised").
export const RETURN_REASON_CODES = [
  'refused',
  'not_home',
  'wrong_address',
  'unreachable',
  'rescheduled',
  'price_or_changed_mind',
  'damaged',
  'other',
  'unknown',
];

export const COMMERCE_OUTCOME_KINDS = [
  'order_created',
  'cod_confirmed',
  'cod_refused',
  'cod_no_reply',
  'picked_up',
  'delivered',
  'returned',
  'cancelled',
  'refunded',
];

// Columns that exist only in D1 and were added after `0001_init.sql` reached the production database. `since` is the
// migration number that adds the column (generated into `migrations/platform/<since>_late_columns.sql`); 0001 is generated
// WITHOUT it, so a fresh database gets the column exactly once and a live one gets it from the numbered migration.
export const LATE_COLUMN_MIGRATIONS = {
  3: 'late_columns',
  7: 'billing_eta_fields',
  10: 'store_template_original',
  14: 'billing_reminder_notice_sent',
  19: 'pending_billing_interval',
};

// Columns that ARE in schema.prisma but reached production D1 after 0001 was applied: the generator flags them `since: n`
// (0001 is emitted without them, the numbered migration adds each once), exactly like an `extraColumns` entry. `{ Model: { field: n } }`.
export const latePrismaColumns = {
  // Ruling BILLING-INTERVAL-PENDING-1: the interval an active store picked at checkout, applied when its payment is recorded.
  StoreSubscription: { pendingBillingInterval: 19 },
};

export const extraColumns = {
  // TAX-1 (NEON-FOLD-1 9.1): Ebda's own invoices are VAT / ETA ready. Filled and policed by 0004_billing_tax_ready.sql.
  BillingEvent: [
    f('netMinor', 'Int', { default: '0', since: 3, note: 'minor units, excl. VAT (gross - vat)' }),
    f('vatRateBp', 'Int', {
      default: '0',
      since: 3,
      note: 'basis points (1400 = 14%) the VAT was computed at',
    }),
    f('grossMinor', 'Int', {
      default: '0',
      since: 3,
      note: 'minor units incl. VAT (= amount_minor); gross = net + vat',
    }),
    f('sellerLegalName', 'String', {
      optional: true,
      since: 3,
      note: 'SELLER snapshot (packages/shared brand/billing-vat)',
    }),
    f('sellerTaxId', 'String', {
      optional: true,
      since: 3,
      note: 'SELLER snapshot, NULL until filled',
    }),
    f('buyerTaxId', 'String', { optional: true, since: 3, note: 'B2B buyer tax id, optional' }),
    f('etaUuid', 'String', { optional: true, since: 3, note: 'ETA-issued document uuid' }),
    f('etaStatus', 'String', {
      kind: 'enum',
      enumValues: ['not_submitted', 'submitted', 'accepted', 'rejected'],
      default: 'not_submitted',
      since: 3,
      note: 'e-invoice status; no submission code ships yet',
    }),
    f('etaSubmittedAt', 'DateTime', {
      optional: true,
      since: 3,
      note: 'when the invoice was submitted to ETA',
    }),
    // FOLD-VAT (data side of TAX-1): the rest of an ETA document's identity. All NULL until submission code ships.
    f('etaLongId', 'String', {
      optional: true,
      since: 7,
      note: 'ETA longId (the id the QR / portal link uses)',
    }),
    f('etaHash', 'String', {
      optional: true,
      since: 7,
      note: 'ETA document hash key returned on acceptance',
    }),
    f('etaRejectionReason', 'String', {
      optional: true,
      since: 7,
      note: 'ETA rejection text for a rejected submission; an operator reads it',
    }),
  ],
  BillingReminder: [
    f('noticeSentAt', 'DateTime', {
      optional: true,
      since: 14,
      note: 'BILL-NOTICE-3 outbox: NULL = claimed, notice not yet confirmed sent',
    }),
    f('noticeLeaseUntil', 'DateTime', {
      optional: true,
      since: 14,
      note: 'BILL-NOTICE-3 outbox: a resend worker holds the row until this moment (created_at stays immutable)',
    }),
    f('noticeAttempts', 'Int', {
      default: '0',
      since: 14,
      note: 'BILL-NOTICE-3 outbox: resend attempts taken; capped so a notice that keeps failing stops',
    }),
  ],
  Store: [
    f('storageBackend', 'String', {
      kind: 'enum',
      enumValues: ['pg', 'do'],
      default: 'pg',
      note: 'Per-store backend selector (task 2.4 + flip-backend): pg = Postgres, do = this store runs on its StoreDO. Lives in D1 (the directory) so the router can read it before it knows which DO to call.',
    }),
    // Ruling SKIN-DEL-10 (expand step of expand/contract): 0009 remapped retired skins lossily and kept nothing. This keeps
    // the pre-remap value for the rows 0011 can still name (best effort), so the remap can be reverted. Never read by code.
    f('templateOriginal', 'String', {
      optional: true,
      since: 10,
      note: 'the template before 0009 remapped a retired skin (revert path); NULL = never remapped or not recorded',
    }),
  ],
  Customer: [
    f('buyerKey', 'String', { optional: true, note: 'same HMAC buyer key as orders.buyer_key' }),
  ],
};

// Indexes that go with the added columns: [model, columns].
// (The Shipment/Order CI-1 columns and their indexes moved into schema.prisma + the CI-1 migration; only
// Customer.buyerKey, which has no Postgres counterpart yet, is still a Cloudflare-only addition.)
export const extraIndexes = [['Customer', ['buyerKey']]];

export const extraModels = {
  'store-do': [
    {
      name: 'CommerceOutcome',
      dbName: 'commerce_outcomes',
      appendOnly: true,
      note: 'CI-1 append-only outcome stream. The DO is the outbox: a row is written in the same transactionSync as the event it records, then shipped to Analytics Engine + R2 and stamped exported_at (the only column that may change).',
      id: null,
      fields: [
        f('id', 'String', { id: true }),
        f('storeId', 'String'),
        f('kind', 'String', { kind: 'enum', enumValues: COMMERCE_OUTCOME_KINDS }),
        f('orderId', 'String', { optional: true }),
        f('buyerKey', 'String', { optional: true }),
        f('areaKey', 'String', { optional: true }),
        f('carrier', 'String', { optional: true }),
        f('paymentMethod', 'String', { optional: true }),
        f('amount', 'Int', { optional: true, note: 'piastres' }),
        f('reasonCode', 'String', {
          optional: true,
          kind: 'enum',
          enumValues: RETURN_REASON_CODES,
        }),
        f('reasonRaw', 'String', { optional: true }),
        f('source', 'String', {
          kind: 'enum',
          enumValues: ['store', 'whatsapp'],
          default: 'store',
          note: 'WhatsApp-sourced outcomes are not re-emitted by the Store (contract section 6)',
        }),
        f('occurredAt', 'DateTime'),
        f('exportedAt', 'DateTime', { optional: true }),
      ],
      uniques: [
        {
          fields: [
            { field: 'storeId' },
            { field: 'orderId' },
            { field: 'kind' },
            { field: 'source' },
          ],
          map: null,
        },
      ],
      indexes: [
        { fields: [{ field: 'exportedAt' }], map: null },
        { fields: [{ field: 'storeId' }, { field: 'occurredAt', desc: true }], map: null },
      ],
    },
    {
      name: 'DoFlag',
      dbName: 'do_flags',
      note: 'Per-DO transaction flags that replace Postgres GUCs read by triggers (app.gold_reprice). Set and cleared inside one transactionSync by the repricer only.',
      id: null,
      fields: [f('name', 'String', { id: true }), f('value', 'Int', { default: '0' })],
      uniques: [],
      indexes: [],
    },
    {
      name: 'D1Outbox',
      dbName: 'd1_outbox',
      note: 'Write-through outbox to D1 (Task 1.4 + entity index): rows are retried by the DO alarm until the D1 write is acknowledged.',
      id: null,
      fields: [
        f('id', 'Int', { id: true, default: 'autoincrement()' }),
        f('kind', 'String', { kind: 'enum', enumValues: ['directory_update', 'entity_index'] }),
        f('payload', 'Json', { kind: 'scalar' }),
        f('attempts', 'Int', { default: '0' }),
        f('nextAttemptAt', 'DateTime'),
        f('doneAt', 'DateTime', { optional: true }),
        f('createdAt', 'DateTime', { default: 'now()' }),
      ],
      uniques: [],
      indexes: [{ fields: [{ field: 'doneAt' }, { field: 'nextAttemptAt' }], map: null }],
    },
  ],
  d1: [
    {
      name: 'EntityIndex',
      dbName: 'entity_index',
      note: 'Cross-store lookup by entity id (replaces the ebda_*_store_id SECURITY DEFINER functions): written by the StoreDO through its outbox, read by the platform repo.',
      id: ['kind', 'id'],
      fields: [
        f('kind', 'String', {
          kind: 'enum',
          enumValues: [
            'order',
            'payment',
            'shipment',
            'customer',
            'return',
            'refund',
            'webhook',
            'instapay_ref',
          ],
        }),
        f('id', 'String'),
        f('storeId', 'String'),
        // the entity that holds a claim-style key (kind `instapay_ref`: the receipt id); null for plain lookups
        f('claimRef', 'String', { optional: true }),
        f('createdAt', 'DateTime', { default: 'now()' }),
      ],
      uniques: [],
      indexes: [{ fields: [{ field: 'storeId' }], map: null }],
    },
    {
      name: 'PlatformAuditLog',
      dbName: 'platform_audit_log',
      note: 'Platform-level (super-admin) audit trail; per-store audit rows live in the StoreDO audit_logs table.',
      id: null,
      fields: [
        f('id', 'String', { id: true, default: 'uuid()' }),
        f('actorId', 'String', { optional: true }),
        f('action', 'String'),
        f('targetType', 'String', { optional: true }),
        f('targetId', 'String', { optional: true }),
        f('storeId', 'String', { optional: true }),
        f('meta', 'Json', { default: '"{}"' }),
        f('createdAt', 'DateTime', { default: 'now()' }),
      ],
      uniques: [],
      indexes: [
        { fields: [{ field: 'createdAt', desc: true }], map: null },
        { fields: [{ field: 'storeId' }, { field: 'createdAt', desc: true }], map: null },
      ],
    },
  ],
};
