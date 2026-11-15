/**
 * The Ebda Store adapter for the Smart Layer engine (plan 4 Tasks A15/A16). It holds no model logic: it wires the engine to this product's
 * bindings (Workers AI, Vectorize, the store's own StoreDO journal, D1 switches, the AI usage meter) and to the Merchant MCP read handlers.
 * Everything that calls Workers AI through the engine lives under `apps/api/src/smart-layer/` (the `smart-layer-bypass` guard allowlist).
 */
import {
  BUDGET,
  resolveModels,
  type AiBinding,
  type BindingSource,
  type RefCheck,
  type RegistryView,
  type SmartLayerAdapter,
  type ToolSpec,
  type TurnCtx,
} from '@ebda/shared/smart-layer';
import { cfBindings } from '../cf/bindings';
import { storeDb, storeSmartLayer } from '../lib/repo-factory';
import { planService } from '../services/plan.service';
import { storeControls } from './controls';
import { storeHandoff } from './handoff';
import {
  helpDeps,
  helpFigureSources,
  helpSearch,
  type HelpCorpus,
  type HelpDeps,
} from './help-index';
import { storeQuota } from './quota';
import { storeRegistry } from './registry';
import { doStorage } from './storage-do';
import { changeTools } from './tools/change-tools';
import { readTools, type ToolDeps } from './tools/read.tools';

// pq-allow(unused-export): imported by tests/unit/assistant-adapter.test.ts
export const ASSISTANT_CAPABILITY = 'ai.merchant-assistant';
const REF_MODELS: Record<string, 'product' | 'order' | 'customer'> = {
  product: 'product',
  order: 'order',
  customer: 'customer',
};
const SECURE: Record<string, string | null> = {
  password: 'account.password',
  card: 'billing.pay-card',
  api_key: 'mcp.read-tools',
  meta_token: null,
  cf_token: null,
  jwt: null,
  private_key: null,
};

export type StoreAdapterDeps = {
  storeId: string;
  /** Overrides for tests (a scripted model needs none of them). */
  help?: HelpDeps;
  corpus?: HelpCorpus;
  registry?: RegistryView;
  ai?: AiBinding;
  tools?: Partial<Pick<ToolDeps, 'read' | 'plans' | 'setupGuide'>>;
  /** Test seam: replaces the write tools (production never sets it). */
  changeTools?: ToolSpec[];
  quota?: Parameters<typeof storeQuota>[1];
  controls?: Parameters<typeof storeControls>[1];
  checkRef?: (storeId: string, r: RefCheck) => Promise<boolean>;
};

const egp = (minor: number | null): string => String(Math.round(minor ?? 0) / 100);

async function refExists(storeId: string, r: RefCheck): Promise<boolean> {
  const model = REF_MODELS[r.kind];
  if (!model) return false; // an unknown kind fails closed
  const db = await storeDb(storeId);
  const where = { where: { id: r.id }, select: { id: true } };
  const row =
    model === 'product'
      ? await db.product.findFirst(where)
      : model === 'order'
        ? await db.order.findFirst(where)
        : await db.customer.findFirst(where);
  return !!row;
}

export function storeAdapter(d: StoreAdapterDeps): SmartLayerAdapter {
  const help = d.help ?? helpDeps();
  const registry = d.registry ?? storeRegistry();
  const storage = doStorage(async (op, args) => (await storeSmartLayer(d.storeId))(op, args));
  const searchHelp = (q: string, locale: TurnCtx['locale'], k: number) =>
    helpSearch(help, q, locale, k);
  const tools = [
    ...readTools({
      helpSearch: searchHelp,
      registry,
      assistantCapability: ASSISTANT_CAPABILITY,
      ...(d.tools ?? {}),
    }),
    ...(d.changeTools ?? changeTools()),
  ];
  return {
    product: 'store',
    registry: () => registry,
    tools: () => tools,
    helpSearch: searchHelp,
    async bindingSources(): Promise<BindingSource[]> {
      // Typed sources for the binding-claim rail: the plans the billing page sells, the free cap, and the figures the help guides state.
      const plans = await (d.tools?.plans ?? (() => planService.listPlans({ publicOnly: true })))();
      return [
        ...plans.map(
          (p): BindingSource => ({
            kind: 'plan',
            key: p.code,
            text: { ar: p.nameAr, en: p.nameEn },
            values: [
              p.nameAr,
              p.nameEn,
              ...(p.priceMonthlyMinor === null ? [] : [egp(p.priceMonthlyMinor)]),
              ...(p.priceYearlyMinor === null ? [] : [egp(p.priceYearlyMinor)]),
            ],
          })
        ),
        {
          kind: 'limit',
          key: 'assistant-free-turns',
          text: { ar: 'رسايل المساعد المجانية في اليوم', en: 'Free assistant messages per day' },
          values: [String(BUDGET.freeTurnsPerStorePerDay)],
        },
        ...(await helpFigureSources(d.corpus)),
      ];
    },
    async merchantDomains(ctx) {
      // Links only to hosts the merchant really owns: the platform subdomain, and the custom domain once it is VERIFIED (a pending claim is not theirs yet).
      const row = await (
        await storeDb(ctx.storeId)
      ).store.findUnique({
        where: { id: ctx.storeId },
        select: { slug: true, domain: true, domainStatus: true },
      });
      return [
        ...(row?.slug ? [`${row.slug}.ebda.app`] : []),
        ...(row?.domain && row.domainStatus === 'active' ? [row.domain] : []),
      ];
    },
    controls: ctx => storeControls(ctx.storeId, d.controls),
    quota: storeQuota(storage, d.quota),
    async checkRefs(ctx, refs) {
      const check = d.checkRef ?? refExists;
      const missing: RefCheck[] = [];
      for (const r of refs) if (!(await check(ctx.storeId, r).catch(() => false))) missing.push(r);
      return { missing };
    },
    handoff: storeHandoff(),
    secureScreen: kind => SECURE[kind] ?? null,
    ai: d.ai ??
      (cfBindings()?.AI as unknown as AiBinding | undefined) ?? {
        run: async () => {
          throw new Error('no AI binding');
        },
      },
    models: resolveModels(),
    storage,
  };
}
