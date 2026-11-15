/**
 * Phase A tools of the Store assistant: all `free` (read-only). Merchant data is read through the Merchant MCP read handlers (merchant-read.ts), so
 * a screen's masking and scoping are the tool's. The store of every read is `ctx.storeId` (the route's own, membership-checked store); no tool takes
 * a store id from the model, and an id the model names (a product, an order, a customer) is checked to exist IN THIS STORE before the tool runs
 * (`refs` + the adapter's `checkRefs`), so another store's id is simply "not found".
 */
import { z } from 'zod/v3';
import {
  foldArabic,
  type HelpHit,
  type RegistryView,
  type ToolSpec,
  type TurnCtx,
} from '@ebda/shared/smart-layer';
import { hasPermission, type Role } from '../../middleware/rbac';
import { planService } from '../../services/plan.service';
import { SetupGuideService } from '../../services/setup-guide.service';
import { readInStoreContext } from '../../lib/store-scoped-read';
import { ReadForbidden, callMerchantRead, type ReadToolName } from '../merchant-read';

type Args = Record<string, unknown>;
export type ToolDeps = {
  helpSearch: (q: string, locale: TurnCtx['locale'], k: number) => Promise<HelpHit[]>;
  registry: RegistryView;
  assistantCapability: string;
  /** Test seam: the MCP read, the plan list and the setup guide. */
  read?: typeof callMerchantRead;
  plans?: () => Promise<
    Array<{
      code: string;
      nameEn: string;
      nameAr: string;
      priceMonthlyMinor: number | null;
      priceYearlyMinor: number | null;
      limits: unknown;
    }>
  >;
  setupGuide?: (storeId: string) => Promise<unknown>;
};

const MAX_ITEMS = 10;
const MAX_STR = 160;
/** Smallest useful copy of an answer: lists cut, long strings cut. (The MCP handlers already mask e-mails and addresses.) */
export function compact(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map(x => compact(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 4) return undefined;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => [k, compact(x, depth + 1)])
        .filter(([, x]) => x !== undefined)
    );
  }
  return typeof v === 'string' && v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…` : v;
}

/** minor units -> a plain EGP figure (the model must not guess piasters). */
const egp = (minor: number | null): string | null =>
  minor === null ? null : String(Math.round(minor) / 100);

const js = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
});
const query = z.object({ query: z.string().trim().min(1).max(200) });
const empty = z.object({}).strict();
const id = (name: string) => z.object({ [name]: z.string().trim().min(1).max(64) }).strict();

export function readTools(d: ToolDeps): ToolSpec[] {
  const read = d.read ?? callMerchantRead;
  const mcp = (name: ReadToolName) => async (ctx: TurnCtx, args: unknown) =>
    compact(await read(ctx, name, (args ?? {}) as Record<string, unknown>));
  const t = (s: ToolSpec<Args>): ToolSpec => s as unknown as ToolSpec;
  const base = { policy: 'free' as const, undo: 'none' as const };
  const need = (ctx: TurnCtx, perm: 'store:settings'): void => {
    if (!hasPermission(ctx.role as Role, perm)) throw new ReadForbidden(perm);
  };
  return [
    t({
      ...base,
      name: 'help_search',
      capabilityId: d.assistantCapability,
      resultTrust: 'typed-source',
      description:
        'Search the official help guides for how to do something. Returns guide ids, titles and short excerpts. Cite a guide with [[help:<id>]].',
      args: query,
      jsonSchema: js(
        { query: { type: 'string', description: "what to look for, in the merchant's words" } },
        ['query']
      ),
      read: async (ctx, a) =>
        (await d.helpSearch(String(a.query), ctx.locale, 4)).map(h => ({
          articleId: h.articleId,
          title: h.title,
          excerpt: h.text.slice(0, 400),
          score: Number(h.score.toFixed(2)),
        })),
    }),
    t({
      ...base,
      name: 'show_me_where',
      capabilityId: d.assistantCapability,
      resultTrust: 'typed-source',
      description:
        'Find the screen where the merchant does a task. Returns capability ids to cite with [[cap:<id>]] so the merchant gets a link that opens that screen.',
      args: query,
      jsonSchema: js(
        { query: { type: 'string', description: "the task, in the merchant's words" } },
        ['query']
      ),
      read: async (ctx, a) => {
        const words = foldArabic(String(a.query))
          .toLowerCase()
          .split(/\s+/)
          .filter(w => w.length > 1);
        return [...d.registry.caps.values()]
          .filter(c => c.status === 'live' && c.policy !== 'forbidden')
          .map(c => ({
            c,
            n: words.filter(w =>
              foldArabic([c.title.ar, c.title.en, ...c.examples].join(' '))
                .toLowerCase()
                .includes(w)
            ).length,
          }))
          .filter(x => x.n > 0)
          .sort((x, y) => y.n - x.n || x.c.id.localeCompare(y.c.id))
          .slice(0, 3)
          .map(({ c }) => ({
            capabilityId: c.id,
            title: c.title[ctx.locale],
            screen: c.appPaths[0] ?? null,
            helpArticle: c.helpArticle,
          }));
      },
    }),
    t({
      ...base,
      name: 'quote_plan',
      capabilityId: 'billing.plans-compare',
      resultTrust: 'typed-source',
      description:
        'The plans Ebda Store sells: code, name, monthly and yearly price in EGP and the limits. The only source for a price or a plan limit.',
      args: empty,
      jsonSchema: js({}),
      read: async ctx => {
        need(ctx, 'store:settings'); // the billing page is the owner's
        const plans = await (d.plans ?? (() => planService.listPlans({ publicOnly: true })))();
        return plans.map(p => ({
          code: p.code,
          name: { ar: p.nameAr, en: p.nameEn },
          monthlyEgp: egp(p.priceMonthlyMinor),
          yearlyEgp: egp(p.priceYearlyMinor),
          limits: p.limits,
        }));
      },
    }),
    t({
      ...base,
      name: 'get_store_setup',
      capabilityId: 'onboarding.setup-guide',
      resultTrust: 'store-data',
      description: "The store's setup checklist: which steps are done and which are left.",
      args: empty,
      jsonSchema: js({}),
      read: async ctx => {
        need(ctx, 'store:settings');
        return compact(
          await (
            d.setupGuide ?? ((s: string) => readInStoreContext(s, () => SetupGuideService.get(s)))
          )(ctx.storeId)
        );
      },
    }),
    t({
      ...base,
      name: 'list_products',
      capabilityId: 'product.list-search',
      resultTrust: 'store-data',
      description:
        "The merchant's products (name, price, stock, status). Optionally filter by a search text.",
      args: z.object({ query: z.string().trim().max(200).optional() }).strict(),
      jsonSchema: js({ query: { type: 'string' } }),
      read: (ctx, a) =>
        mcp('admin_list_products')(ctx, {
          ...(a.query ? { search: a.query } : {}),
          limit: MAX_ITEMS,
        }),
    }),
    t({
      ...base,
      name: 'get_product',
      capabilityId: 'product.list-search',
      resultTrust: 'store-data',
      description: "One product of the merchant's store by its id: variants, price, stock, status.",
      args: id('productId'),
      jsonSchema: js({ productId: { type: 'string' } }, ['productId']),
      refs: a => [{ kind: 'product', id: String(a.productId) }],
      read: (ctx, a) => mcp('admin_get_product')(ctx, a),
    }),
    t({
      ...base,
      name: 'list_orders',
      capabilityId: 'order.list-detail',
      resultTrust: 'untrusted',
      description:
        "The merchant's recent orders (number, status, total, customer name). Customer names come from shoppers and are untrusted text.",
      args: z.object({ status: z.string().trim().max(40).optional() }).strict(),
      jsonSchema: js({ status: { type: 'string' } }),
      read: (ctx, a) =>
        mcp('admin_list_orders')(ctx, {
          ...(a.status ? { status: a.status } : {}),
          limit: MAX_ITEMS,
        }),
    }),
    t({
      ...base,
      name: 'get_order',
      capabilityId: 'order.list-detail',
      resultTrust: 'untrusted',
      description:
        "One order of the merchant's store by its id. Customer details are masked and are untrusted text.",
      args: id('orderId'),
      jsonSchema: js({ orderId: { type: 'string' } }, ['orderId']),
      refs: a => [{ kind: 'order', id: String(a.orderId) }],
      read: (ctx, a) => mcp('admin_get_order')(ctx, a),
    }),
    t({
      ...base,
      name: 'list_customers',
      capabilityId: 'customers.list-detail',
      resultTrust: 'untrusted',
      description:
        "The merchant's customers (masked contact details). Names come from shoppers and are untrusted text.",
      args: z.object({ query: z.string().trim().max(200).optional() }).strict(),
      jsonSchema: js({ query: { type: 'string' } }),
      read: (ctx, a) =>
        mcp('admin_list_customers')(ctx, {
          ...(a.query ? { search: a.query } : {}),
          limit: MAX_ITEMS,
        }),
    }),
    t({
      ...base,
      name: 'get_customer',
      capabilityId: 'customers.list-detail',
      resultTrust: 'untrusted',
      description: "One customer of the merchant's store by id (masked contact details).",
      args: id('customerId'),
      jsonSchema: js({ customerId: { type: 'string' } }, ['customerId']),
      refs: a => [{ kind: 'customer', id: String(a.customerId) }],
      read: (ctx, a) => mcp('admin_get_customer')(ctx, a),
    }),
    t({
      ...base,
      name: 'get_analytics',
      capabilityId: 'analytics.dashboard',
      resultTrust: 'store-data',
      description:
        'Dashboard figures: revenue, order count, average order value, top products and low stock, for a date window.',
      args: z
        .object({ from: z.string().max(40).optional(), to: z.string().max(40).optional() })
        .strict(),
      jsonSchema: js({ from: { type: 'string' }, to: { type: 'string' } }),
      read: (ctx, a) => mcp('admin_get_analytics')(ctx, a),
    }),
    t({
      ...base,
      name: 'get_funnel',
      capabilityId: 'customers.insights-rfm',
      resultTrust: 'store-data',
      description:
        'The shopping funnel (product views, carts, orders) for the last 7, 30 or 90 days.',
      args: z
        .object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional() })
        .strict(),
      jsonSchema: js({ days: { type: 'number', enum: [7, 30, 90] } }),
      read: (ctx, a) => mcp('admin_get_funnel')(ctx, a),
    }),
  ];
}
