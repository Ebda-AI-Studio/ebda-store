/**
 * Plan-gate refusals the API client has handed to pages, keyed by the localized message the page received.
 *
 * ~60 pages do `setError(apiError.message)` and hand that string to <PageState>/<ErrorState>. A 402 (plan limit / analytics
 * tier) or a 403 FEATURE_DISABLED is not a failure: the merchant needs an upgrade card, not a destructive error with a
 * "try again" that can never succeed. apiRequest registers the structured refusal here (status, code, details) and ErrorState
 * looks the message up, so every page shows the designed card without each one being rewritten.
 * Bounded (last 50): a stale entry can only make an identical message render as the card, which is what it already means.
 */
import { isPlanGateError } from './route-feature-gates';

export interface PlanGateInfo {
  status: number;
  code: string;
  details?: Record<string, unknown>;
}

const MAX = 50;
const registry = new Map<string, PlanGateInfo>();

/** Remember a refusal if (and only if) it is a plan refusal. Returns whether it was one. */
export function registerPlanGate(
  message: string,
  info: { status?: number; code?: string; details?: Record<string, unknown> }
): boolean {
  if (!message || !isPlanGateError(info)) return false;
  registry.delete(message);
  registry.set(message, {
    status: info.status as number,
    code: info.code ?? '',
    details: info.details,
  });
  if (registry.size > MAX) registry.delete(registry.keys().next().value as string);
  return true;
}

/** The plan refusal behind an error message a page is about to render, or null for an ordinary error. */
export function planGateFor(message: string | null | undefined): PlanGateInfo | null {
  return message ? (registry.get(message) ?? null) : null;
}

export interface PlanGateView {
  limitKey: string | null;
  required: string | null;
  plan: { code: string; nameAr: string; nameEn: string } | null;
}

/** The parts of the refusal the card shows: which limit, which tier, which sold plan unlocks it. */
export function planGateView(info: PlanGateInfo): PlanGateView {
  const d = info.details ?? {};
  const up = d.upgradeTo;
  let plan: PlanGateView['plan'] = null;
  if (up && typeof up === 'object') {
    const u = up as { code?: string; nameAr?: string; nameEn?: string };
    if (u.code) plan = { code: u.code, nameAr: u.nameAr ?? u.code, nameEn: u.nameEn ?? u.code };
  } else if (typeof up === 'string' && up) {
    plan = { code: up, nameAr: up, nameEn: up };
  }
  return {
    limitKey: typeof d.limitKey === 'string' ? d.limitKey : null,
    required: typeof d.required === 'string' ? d.required : null,
    plan,
  };
}
