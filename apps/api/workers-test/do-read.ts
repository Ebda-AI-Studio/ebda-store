import { env } from 'cloudflare:workers';

type DoAnswer = { ok: true; json: string } | { ok: false; code: string; message?: string };
const e = env as unknown as {
  STORE_DO: {
    idFromName(n: string): unknown;
    get(id: unknown): {
      query(storeId: string, q: unknown[]): Promise<DoAnswer>;
      mutate(storeId: string, m: unknown): Promise<DoAnswer>;
      authOp(storeId: string, op: string, argsJson: string): Promise<unknown>;
      applySettings(
        storeId: string,
        fieldsJson: string
      ): Promise<{ ok: true } | { ok: false; code: string }>;
      storeRecord(
        storeId: string,
        fields?: string[]
      ): Promise<{ ok: true; data: { json: string } } | { ok: false; code: string }>;
    };
  };
};

/** Read rows straight from a store's StoreDO (the state after an HTTP write), as feature-gated-do.test.ts does. */
// pq-allow(unused-export): test seam; its only importers are workerd test files (demo-store.test.ts), which the guard does not count as a use
export async function doRead<T = Record<string, any>>(
  storeId: string,
  model: string,
  args: Record<string, unknown>
): Promise<T[]> {
  const a = await e.STORE_DO.get(e.STORE_DO.idFromName(storeId)).query(storeId, [
    { model, op: 'findMany', args },
  ]);
  if (!a.ok) throw new Error(`DO refused: ${a.code} ${a.message ?? ''}`);
  return (JSON.parse(a.json) as T[][])[0]!;
}

/** The Store record (profile + config columns) from the StoreDO: the Store row is not a findMany delegate in the DO. */
// pq-allow(unused-export): workerd test seam; its importers are workers-test/*.test.ts files, which the guard does not count as a use
export async function doStoreRecord(
  storeId: string,
  fields?: string[]
): Promise<Record<string, any>> {
  const a = await e.STORE_DO.get(e.STORE_DO.idFromName(storeId)).storeRecord(storeId, fields);
  if (!a.ok) throw new Error(`DO refused: ${a.code}`);
  return JSON.parse(a.data.json);
}

/** Insert a row straight into a store's StoreDO (a fixture an HTTP route cannot make, e.g. a legacy archived revision). */
// pq-allow(unused-export): workerd test seam; its importers are workers-test/*.test.ts files, which the guard does not count as a use
export async function doCreate(
  storeId: string,
  model: string,
  data: Record<string, unknown>
): Promise<void> {
  const a = await e.STORE_DO.get(e.STORE_DO.idFromName(storeId)).mutate(storeId, {
    ops: [{ model, op: 'create', args: { data: { id: crypto.randomUUID(), ...data } } }],
  });
  if (!a.ok) throw new Error(`DO refused: ${a.code} ${a.message ?? ''}`);
}

/** Write Store record fields into the StoreDO as the settings copy does (an out-of-band write: template, layoutSettings, ...). */
// pq-allow(unused-export): workerd test seam; its importers are workers-test/*.test.ts files, which the guard does not count as a use
export async function doSetStoreFields(
  storeId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const a = await e.STORE_DO.get(e.STORE_DO.idFromName(storeId)).applySettings(
    storeId,
    JSON.stringify(fields)
  );
  if (!a.ok) throw new Error(`DO refused: ${a.code}`);
}

/** Delete rows straight from a store's StoreDO (resets a fixture an HTTP route seeded, e.g. the onboarding page revisions). */
// pq-allow(unused-export): workerd test seam; its importers are workers-test/*.test.ts files, which the guard does not count as a use
export async function doDeleteMany(
  storeId: string,
  model: string,
  where: Record<string, unknown>
): Promise<void> {
  const a = await e.STORE_DO.get(e.STORE_DO.idFromName(storeId)).mutate(storeId, {
    ops: [{ model, op: 'deleteMany', args: { where } }],
  });
  if (!a.ok) throw new Error(`DO refused: ${a.code} ${a.message ?? ''}`);
}

/** A customer-auth op on the StoreDO (what /auth/register and friends call): the customer accounts are `_cauth_*` tables, not Prisma models. */
// pq-allow(unused-export): workerd test seam; its importers are workers-test/*.test.ts files, which the guard does not count as a use
export function doAuthOp(
  storeId: string,
  op: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return e.STORE_DO.get(e.STORE_DO.idFromName(storeId)).authOp(storeId, op, JSON.stringify(args));
}
