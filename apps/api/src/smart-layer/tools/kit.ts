/**
 * The one way a Store assistant tool is declared (plan 4 Tasks B6 / C2 / E1-E5). A change tool is a few pure parts; this file owns the parts every
 * tool must get right so no tool can forget one:
 *   - the merchant's own RBAC + plan gate runs at PREVIEW time too (a merchant who may not do it never sees a card for it) and again at apply, through
 *     `runAsMerchant` (SL-STORE-2: the same chain the Merchant MCP write tools use; audit row "user X via assistant", fail closed);
 *   - the etag is a hash of the CURRENT state of the targets, read at preview and again at apply, so a change made by hand in between re-previews;
 *   - the store comes from `ctx.storeId` (the route's own, membership-checked store), never from tool arguments;
 *   - the inverse is built from the BEFORE values captured in the preview payload, and restores them through the same tool.
 * Policy, undo class and capability live next to the tool and are checked against the registry by tests/unit/assistant-tools-registry.test.ts.
 */
import { z, type ZodTypeAny } from 'zod/v3';
import {
  ToolForbidden,
  canonicalJson,
  sha256Hex,
  type InverseOp,
  type PreviewRow,
  type RefCheck,
  type ToolSpec,
  type TurnCtx,
  type UndoClass,
} from '@ebda/shared/smart-layer';
import { readInStoreContext } from '../../lib/store-scoped-read';
import {
  MerchantForbidden,
  assertMerchantMay,
  runAsMerchant,
  type MerchantGate,
} from '../../mcp/run-as-merchant';

// ---- one declaration -> the zod schema and the JSON schema the model sees --------------------------------------------------------------------
type Field = { z: ZodTypeAny; js: Record<string, unknown> };
const strip = (d: string | undefined) => (d ? { description: d } : {});
export const f = {
  str: (description?: string, o: { max?: number; min?: number } = {}): Field => ({
    z: z
      .string()
      .trim()
      .min(o.min ?? 1)
      .max(o.max ?? 500),
    js: { type: 'string', maxLength: o.max ?? 500, ...strip(description) },
  }),
  /** A string that may be set to empty (clears the value). */
  text: (description?: string, o: { max?: number } = {}): Field => ({
    z: z
      .string()
      .trim()
      .max(o.max ?? 5000),
    js: { type: 'string', maxLength: o.max ?? 5000, ...strip(description) },
  }),
  id: (description?: string): Field => ({
    z: z.string().trim().min(1).max(64),
    js: { type: 'string', maxLength: 64, ...strip(description) },
  }),
  int: (description?: string, o: { min?: number; max?: number } = {}): Field => ({
    z: z
      .number()
      .int()
      .min(o.min ?? 0)
      .max(o.max ?? 1_000_000_000),
    js: {
      type: 'integer',
      minimum: o.min ?? 0,
      maximum: o.max ?? 1_000_000_000,
      ...strip(description),
    },
  }),
  num: (description?: string, o: { min?: number; max?: number } = {}): Field => ({
    z: z
      .number()
      .min(o.min ?? 0)
      .max(o.max ?? 1_000_000_000),
    js: {
      type: 'number',
      minimum: o.min ?? 0,
      maximum: o.max ?? 1_000_000_000,
      ...strip(description),
    },
  }),
  bool: (description?: string): Field => ({
    z: z.boolean(),
    js: { type: 'boolean', ...strip(description) },
  }),
  enum: (values: [string, ...string[]], description?: string): Field => ({
    z: z.enum(values),
    js: { type: 'string', enum: values, ...strip(description) },
  }),
  list: (item: Field, o: { max?: number; min?: number; description?: string } = {}): Field => ({
    z: z
      .array(item.z)
      .min(o.min ?? 0)
      .max(o.max ?? 25),
    js: { type: 'array', items: item.js, maxItems: o.max ?? 25, ...strip(o.description) },
  }),
  obj: (shape: Record<string, Field>, required: string[] = [], description?: string): Field => ({
    z: z
      .object(
        Object.fromEntries(
          Object.entries(shape).map(([k, v]) => [k, required.includes(k) ? v.z : v.z.optional()])
        )
      )
      .strict(),
    js: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.js])),
      required,
      additionalProperties: false,
      ...strip(description),
    },
  }),
  /** Marks a field optional-or-null-to-clear. */
  nullable: (x: Field): Field => ({ z: x.z.nullable(), js: { ...x.js, nullable: true } }),
};
export function shape<A = Record<string, unknown>>(
  fields: Record<string, Field>,
  required: string[] = []
): { args: z.ZodType<A>; jsonSchema: Record<string, unknown> } {
  const o = f.obj(fields, required);
  return { args: o.z as unknown as z.ZodType<A>, jsonSchema: o.js };
}

// ---- change tools ---------------------------------------------------------------------------------------------------------------------------
export type Described = {
  summary: { ar: string; en: string };
  rows: PreviewRow[];
  /** How many real items the change touches (computed from rows, never from model text). */
  affectedCount: number;
  /** The BEFORE values the inverse restores. Anything the inverse needs lives here (it is hashed into the approval). */
  restore?: unknown;
  changesPrice?: boolean;
  touchesCheckout?: boolean;
  costCredits?: number;
};

export type ChangeDef<A> = {
  name: string;
  capabilityId: string;
  description: string;
  schema: { args: z.ZodType<A>; jsonSchema: Record<string, unknown> };
  policy?: 'preview' | 'confirm';
  undo: UndoClass;
  money?: boolean;
  deletes?: boolean;
  messagesCustomers?: boolean;
  /** The SAME permission/roles/feature the admin route demands. */
  gate: Pick<MerchantGate, 'permission' | 'roles' | 'feature'>;
  audit: { action: string; resourceType: string; resourceId?: (a: A) => string | undefined };
  refs?: (a: A) => RefCheck[];
  /** Current state of the targets. Depends on the target ids only (never on the new values) so the etag taken after apply equals the one an undo preview takes. */
  state: (ctx: TurnCtx, a: A) => Promise<unknown>;
  describe: (ctx: TurnCtx, a: A, state: unknown) => Described | Promise<Described>;
  /** The mutation: MUST call the same service method the admin route calls. */
  run: (ctx: TurnCtx, a: A, state: unknown) => Promise<unknown>;
  /** Restores `restore` through a tool (usually this one). `result` is what `run` returned (a create tool needs the new id). null = nothing to restore. */
  inverse?: (a: A, restore: unknown, result: unknown) => InverseOp | null;
  /** Rows from other shoppers' text (a review, a customer note) are untrusted. */
  resultTrust?: ToolSpec['resultTrust'];
};

const etagOf = async (state: unknown): Promise<string> =>
  (await sha256Hex(canonicalJson(state ?? null))).slice(0, 32);
export const pair = (ar: string, en: string) => ({ ar, en });
export const row = (ar: string, en: string, before: unknown, after: unknown): PreviewRow => ({
  label: pair(ar, en),
  before,
  after,
});

export function change<A>(d: ChangeDef<A>): ToolSpec {
  const gate = (ctx: TurnCtx) => ({
    ...d.gate,
    storeId: ctx.storeId,
    userId: ctx.userId,
    role: ctx.role,
    tool: d.name,
  });
  const readState = (ctx: TurnCtx, a: A) => readInStoreContext(ctx.storeId, () => d.state(ctx, a));
  const spec: ToolSpec<A> = {
    name: d.name,
    capabilityId: d.capabilityId,
    description: d.description,
    args: d.schema.args,
    jsonSchema: d.schema.jsonSchema,
    policy: d.policy ?? 'preview',
    undo: d.undo,
    ...(d.money ? { money: true } : {}),
    ...(d.deletes ? { deletes: true } : {}),
    ...(d.messagesCustomers ? { messagesCustomers: true } : {}),
    resultTrust: d.resultTrust ?? 'store-data',
    ...(d.refs ? { refs: d.refs } : {}),
    async preview(ctx, a) {
      await assertMerchantMay(gate(ctx)); // a merchant who may not do this never gets a card for it
      const st = await readState(ctx, a);
      const x = await d.describe(ctx, a, st);
      return {
        summary: x.summary,
        rows: x.rows,
        affectedCount: x.affectedCount,
        etag: await etagOf(st),
        payload: { args: a, restore: x.restore ?? null },
        ...(x.changesPrice ? { changesPrice: true } : {}),
        ...(x.touchesCheckout ? { touchesCheckout: true } : {}),
        ...(x.costCredits !== undefined ? { costCredits: x.costCredits } : {}),
      };
    },
    async apply(ctx, a) {
      try {
        const result = await runAsMerchant(
          {
            ...gate(ctx),
            actor: 'assistant',
            audit: {
              action: d.audit.action,
              resourceType: d.audit.resourceType,
              resourceId: d.audit.resourceId?.(a),
            },
            details: { via: 'assistant', conversationId: ctx.conversationId },
          },
          async () => d.run(ctx, a, await d.state(ctx, a))
        );
        return { ok: true, etagAfter: await etagOf(await readState(ctx, a)), result };
      } catch (err) {
        if (err instanceof MerchantForbidden) throw new ToolForbidden();
        throw err;
      }
    },
    ...(d.inverse
      ? {
          inverse: (_ctx, a, draft, applied) =>
            d.inverse!(a, (draft.payload as { restore: unknown }).restore, applied.result),
        }
      : {}),
  };
  return spec as unknown as ToolSpec;
}

/** Builds a compact money string for a card row (piasters -> EGP, plain). */
export const egp = (minor: number | null | undefined): string | null =>
  minor === null || minor === undefined ? null : String(Math.round(minor) / 100);
/** Picks the keys of `src` named in `keys` (the BEFORE values of exactly the fields a change touches). */
export function pick<T extends Record<string, unknown>>(
  src: T | null | undefined,
  keys: string[]
): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) o[k] = src?.[k] ?? null;
  return o;
}
/** Rows for every key of `after`, before taken from `before`. */
export function diffRows(
  labels: Record<string, [string, string]>,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): PreviewRow[] {
  return Object.keys(after).map(k =>
    row(labels[k]?.[0] ?? k, labels[k]?.[1] ?? k, before[k] ?? null, after[k])
  );
}
