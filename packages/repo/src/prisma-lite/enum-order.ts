/**
 * Sort order of enum columns. Postgres sorts an enum by its creation order (`pg_enum.enumsortorder`), SQLite sorts the text.
 * The engine therefore orders an enum column with a CASE over the declared order (`meta.enums`, schema.prisma order). Two
 * enums were later extended with `ALTER TYPE ... ADD VALUE` in a place that differs from the schema file; their Postgres
 * order is pinned here so `ORDER BY status` answers the same on both backends (checked against `pg_enum` for all 49 enums
 * by tests/integration/repo-factory-aggregate-contract.test.ts). Ruling CF-MONEY-1.
 */
export const PG_ENUM_ORDER: Readonly<Record<string, readonly string[]>> = {
  OrderStatus: [
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
    'refunded',
    'awaiting_payment_confirmation',
  ],
  PaymentStatus: [
    'pending',
    'processing',
    'completed',
    'failed',
    'refunded',
    'partially_refunded',
    'disputed',
    'cancelled',
    'expired',
    'cod_pending',
  ],
};

/** `CASE col WHEN 'a' THEN 0 ... END`: the column's value as its position in the enum. */
export function enumRankSql(
  column: string,
  enumName: string,
  declared: Record<string, string[]>
): string {
  const values = PG_ENUM_ORDER[enumName] ?? declared[enumName];
  if (!values || values.length === 0)
    throw new Error(`prisma-lite: unknown enum ${JSON.stringify(enumName)}`);
  const whens = values.map((v, i) => {
    if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error(`prisma-lite: refusing enum value ${v}`);
    return `WHEN '${v}' THEN ${i}`;
  });
  return `CASE ${column} ${whens.join(' ')} END`;
}
