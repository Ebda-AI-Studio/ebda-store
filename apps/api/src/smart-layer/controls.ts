/**
 * Rollout controls for the Store assistant. Platform switches (global kill, Store kill, global mode cap, killed tools) are D1 `system_settings`
 * rows (`sl.global`, `sl.product.store`, `sl.tools`, JSON values) so a super admin changes them without a deploy. The per-store flag is
 * `settings.assistantMode` on the store (default off); a merchant cannot raise it, only a super admin sets it. The merchant's own AI switch
 * (`aiFeaturesEnabled`) ALSO turns the assistant off for that store.
 *
 * Staleness class: NEVER-stale (a kill switch). Nothing here is cached: every turn reads D1 and the store row, and the engine reads them again at
 * apply time. An unreadable switch fails CLOSED (the assistant is off until the read works).
 */
import {
  resolveControls,
  type Controls,
  type Mode,
  type RawControls,
} from '@ebda/shared/smart-layer';
import { cfBindings } from '../cf/bindings';
import { storeDb } from '../lib/repo-factory';
import { isStoreAiEnabled } from '../lib/store-ai-switch';

export const FLAG = {
  global: 'sl.global',
  product: 'sl.product.store',
  tools: 'sl.tools',
} as const;
const MODES: readonly Mode[] = ['off', 'answer-only', 'suggest', 'act'];
const BAD = Symbol('unparseable');
const parse = <T>(s: string | undefined): T | undefined | typeof BAD => {
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return BAD;
  }
};

type D1 = {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};
const platformD1 = (): D1 | undefined =>
  (cfBindings() as { PLATFORM_DB?: D1 } | undefined)?.PLATFORM_DB;

export async function readPlatformFlags(
  db: D1 | undefined = platformD1()
): Promise<Pick<RawControls, 'global' | 'product' | 'killedTools' | 'shadow'>> {
  if (!db) throw new Error('platform db unbound');
  const rows = await db
    .prepare('SELECT key, value FROM system_settings WHERE key IN (?1, ?2, ?3)')
    .bind(FLAG.global, FLAG.product, FLAG.tools)
    .all<{ key: string; value: string }>();
  const by = new Map(rows.results.map(r => [r.key, r.value]));
  // A kill switch that is PRESENT but cannot be read (a hand-edit during an incident) stops the assistant: it never silently stays on.
  const gr = parse<{ kill?: boolean; mode?: Mode; shadow?: boolean }>(by.get(FLAG.global));
  const pr = parse<{ kill?: boolean }>(by.get(FLAG.product));
  const tr = parse<string[]>(by.get(FLAG.tools));
  const g = gr === BAD ? { kill: true } : gr;
  const p = pr === BAD ? { kill: true } : pr;
  const t = tr === BAD ? undefined : tr;
  return {
    global: {
      ...(g?.kill === true ? { kill: true } : {}),
      ...(g?.mode && MODES.includes(g.mode) ? { mode: g.mode } : {}),
    },
    product: { ...(p?.kill === true ? { kill: true } : {}) },
    killedTools: Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [],
    ...(g?.shadow === true ? { shadow: true } : {}),
  };
}

async function readStoreMode(storeId: string): Promise<Mode> {
  const row = await (
    await storeDb(storeId)
  ).store.findUnique({ where: { id: storeId }, select: { settings: true } });
  const m = ((row?.settings ?? {}) as Record<string, unknown>).assistantMode;
  return MODES.includes(m as Mode) ? (m as Mode) : 'off';
}

/** Why the assistant is off for a store (QA-112): the ONE explanation both the merchant `/status` and the super-admin card read. */
export type AssistantOffReason =
  | 'global_kill'
  | 'product_kill'
  | 'platform_cap_off'
  | 'store_ai_off'
  | 'store_mode_off'
  | 'unreadable';

export interface AssistantState {
  controls: Controls;
  enabled: boolean;
  /** null when the assistant is on. */
  reason: AssistantOffReason | null;
  /** The per-store rollout flag the super admin set (before the kill switches, the platform cap and the merchant's AI switch). */
  storeFlag: Mode;
}

/** The single source of truth for "what is the assistant's state for this store, and if off, why". */
export async function assistantState(
  storeId: string,
  deps: {
    flags?: typeof readPlatformFlags;
    mode?: typeof readStoreMode;
    aiOn?: typeof isStoreAiEnabled;
  } = {}
): Promise<AssistantState> {
  try {
    const [flags, storeFlag, aiOn] = await Promise.all([
      (deps.flags ?? readPlatformFlags)(),
      (deps.mode ?? readStoreMode)(storeId),
      (deps.aiOn ?? isStoreAiEnabled)(storeId),
    ]);
    // The platform cap is part of the rollout: an UNSET cap is the most restrictive one (off), never "no cap". A super admin opens the product by setting it.
    const cap = flags.global?.mode ?? 'off';
    const controls = resolveControls({
      storeFlag: aiOn ? storeFlag : 'off',
      ...flags,
      global: { ...flags.global, mode: cap },
    });
    let reason: AssistantOffReason | null = null;
    if (controls.mode === 'off') {
      reason = controls.killGlobal
        ? 'global_kill'
        : controls.killProduct
          ? 'product_kill'
          : !aiOn
            ? 'store_ai_off'
            : storeFlag === 'off'
              ? 'store_mode_off'
              : 'platform_cap_off';
    }
    return { controls, enabled: controls.mode !== 'off', reason, storeFlag };
  } catch {
    // fail closed
    return {
      controls: resolveControls({ storeFlag: 'off', global: { kill: true } }),
      enabled: false,
      reason: 'unreadable',
      storeFlag: 'off',
    };
  }
}

export async function storeControls(
  storeId: string,
  deps: Parameters<typeof assistantState>[1] = {}
): Promise<Controls> {
  return (await assistantState(storeId, deps)).controls;
}

export async function setPlatformFlag(
  key: string,
  value: unknown,
  db: D1 | undefined = platformD1()
): Promise<void> {
  if (!db) throw new Error('platform db unbound');
  await db
    .prepare(
      "INSERT INTO system_settings (id, key, value, category, is_public) VALUES (?1, ?2, ?3, 'ops', 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = ?4"
    )
    .bind(`sl-${key}`, key, JSON.stringify(value), Date.now())
    .run();
}
