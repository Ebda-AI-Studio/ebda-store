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

export const extraColumns = {
  Store: [
    f('storageBackend', 'String', {
      kind: 'enum',
      enumValues: ['pg', 'do'],
      default: 'pg',
      note: 'Per-store backend selector (task 2.4 + flip-backend): pg = Postgres, do = this store runs on its StoreDO. Lives in D1 (the directory) so the router can read it before it knows which DO to call.',
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
