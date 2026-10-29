/**
 * Platform kill switch per hint feature (plan 4.3, Ruling CI-10), stored in `system_settings`
 * (`ci.gate.<feature>`). Open by default. Staleness class NEVER-stale (a closed gate must take effect on
 * the next hint): it is read straight from the database on every hint, with no cache layer.
 */
import { prisma } from '@ebda/database';

export const CI_HINT_FEATURES = ['cod_risk', 'courier', 'fee'] as const;
export type CiHintFeature = (typeof CI_HINT_FEATURES)[number];

const key = (f: CiHintFeature) => `ci.gate.${f}`;

export interface GateState {
  feature: CiHintFeature;
  enabled: boolean;
  reason: string | null;
  at: string | null;
}

const parse = (feature: CiHintFeature, value: unknown): GateState => {
  const v = (value ?? {}) as { enabled?: unknown; reason?: unknown; at?: unknown };
  return {
    feature,
    enabled: v.enabled !== false,
    reason: typeof v.reason === 'string' ? v.reason : null,
    at: typeof v.at === 'string' ? v.at : null,
  };
};

export async function gateState(feature: CiHintFeature): Promise<GateState> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: key(feature) },
    select: { value: true },
  });
  return parse(feature, row?.value);
}

export async function allGates(): Promise<GateState[]> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: CI_HINT_FEATURES.map(key) } },
    select: { key: true, value: true },
  });
  const by = new Map(rows.map(r => [r.key, r.value]));
  return CI_HINT_FEATURES.map(f => parse(f, by.get(key(f))));
}

export async function setGate(
  feature: CiHintFeature,
  enabled: boolean,
  reason: string | null,
  now = new Date()
): Promise<GateState> {
  const value = { enabled, reason, at: now.toISOString() };
  await prisma.systemSetting.upsert({
    where: { key: key(feature) },
    create: { key: key(feature), value, category: 'ci' },
    update: { value },
  });
  return parse(feature, value);
}
