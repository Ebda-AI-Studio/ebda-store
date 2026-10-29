/**
 * `assertAggregateOnly`: the one gate in front of anything that reads aggregates to produce insights or
 * (later) calls a model (plan 3.2, Ruling CI-9). It throws on the first forbidden shape instead of
 * trimming, so a bad payload is a visible failure and an alert, never a silently cleaned one.
 *
 * Rejects: a key named like a buyer/person/order identifier; a string shaped like a phone or an email; a
 * `suppressed: true` cell that carries anything but the flag; a numeric array or an object over
 * 5,000 entries (a dump, not an aggregate).
 */
const FORBIDDEN_KEY =
  /buyer|order_?id|phone|e-?mail|address|(^|[_-])name$|customer|msisdn|whatsapp/i;
const PHONE_SHAPE = /(?:\+|00)?\d(?:[\s().-]?\d){8,}/;
const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
export const MAX_AGGREGATE_ENTRIES = 5000;

const ARABIC_INDIC = /[٠-٩۰-۹]/g;
const westernDigits = (s: string) =>
  s.replace(ARABIC_INDIC, c => String((c.charCodeAt(0) - 0x0660) % 16));

export function assertAggregateOnly(payload: unknown, path = 'payload'): void {
  if (typeof payload === 'string') {
    const t = westernDigits(payload);
    if (PHONE_SHAPE.test(t) || EMAIL_SHAPE.test(t)) {
      throw new Error(`aggregate guard: ${path} looks like a phone number or email`);
    }
    return;
  }
  if (Array.isArray(payload)) {
    if (payload.length > MAX_AGGREGATE_ENTRIES) {
      throw new Error(
        `aggregate guard: ${path} has ${payload.length} entries (max ${MAX_AGGREGATE_ENTRIES})`
      );
    }
    payload.forEach((v, i) => assertAggregateOnly(v, `${path}[${i}]`));
    return;
  }
  if (payload && typeof payload === 'object') {
    const entries = Object.entries(payload as Record<string, unknown>);
    if (entries.length > MAX_AGGREGATE_ENTRIES) {
      throw new Error(
        `aggregate guard: ${path} has ${entries.length} keys (max ${MAX_AGGREGATE_ENTRIES})`
      );
    }
    if ((payload as { suppressed?: unknown }).suppressed === true && entries.length > 1) {
      throw new Error(`aggregate guard: ${path} is suppressed but carries content`);
    }
    for (const [k, v] of entries) {
      if (FORBIDDEN_KEY.test(k))
        throw new Error(`aggregate guard: ${path}.${k} is a forbidden key`);
      assertAggregateOnly(v, `${path}.${k}`);
    }
  }
}
