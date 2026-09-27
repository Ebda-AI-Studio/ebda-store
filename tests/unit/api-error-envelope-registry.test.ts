/**
 * Every route that answers with a BARE-STRING `error` is accounted for.
 *
 * THE CLASS
 *
 * The platform's standard error envelope is an OBJECT —
 * `{ success: false, error: { code, message } }` — shaped by
 * `middleware/error-handler.ts`, and both first-party clients read
 * `data.error?.code`. A route that answers `{ success: false, error: 'CODE' }`
 * instead makes `.code` `undefined`, so the client normalises it to
 * `SERVER_ERROR` and any branch keyed on the real code is dead.
 *
 * That killed the webhook force-replay escape hatch — the headline capability
 * of that feature — from the day it shipped, and it was reported FOUR times
 * (#553, #557, #582, #617) before anyone looked at the shape rather than the
 * symptom. Nothing made the class visible: each report named one route.
 *
 * WHY A REGISTRY AND NOT A SWEEP
 *
 * The flat shape is not always a bug. `cart.service.ts` documents a deliberate
 * flat `{ error: '<code>' }` 422 for the cart-bundles surface, and the
 * WhatsApp bridge is an EXTERNAL consumer whose parser this repo does not own —
 * "fixing" those would break working clients, which is the mirror failure.
 *
 * So: each file that answers with a bare string is either cleaned up, or listed
 * below with who depends on the flat shape. A NEW one fails this test until
 * someone writes down which it is. That question is cheap at the moment the
 * route is written and expensive four bug reports later.
 *
 * This is an enumeration gate and says so. That the object envelope actually
 * reaches the client as a readable code is asserted by executing the real
 * normaliser in `tests/unit/admin-error-envelope.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROUTES = path.resolve(__dirname, '../../apps/api/src/routes');

/** `res.…json({ … error: 'SOME_CODE' … })` — the shape a client cannot read. */
const BARE_STRING_ERROR = /error:\s*'[A-Za-z_]+'/g;

/**
 * Files whose flat `{ error: '<code>' }` shape is DELIBERATE, with the consumer
 * that depends on it.
 *
 * An entry here is a statement that someone checked. "Not looked at yet" goes
 * in the unreviewed list below, which is deliberately uncomfortable.
 */
const DELIBERATE_FLAT_SHAPE: Record<string, string> = {
  'wa-bridge.routes.ts':
    'the WhatsApp bridge is an EXTERNAL consumer — its parser is not in this repo, so changing the shape breaks a client we cannot deploy with',
};

/**
 * Files that predate this registry and have NOT been checked for a consumer.
 *
 * This list is the finding, not the fix. Every entry removed from it is either
 * cleaned up or moved above with a reason. Do not add to it.
 */
const UNREVIEWED_PREDATING_THIS_REGISTRY = new Set([
  'wa-templates.routes.ts',
  'public.routes.ts',
  'inventory.routes.ts',
  // The accounting / finance / insights surfaces (alert-webhooks, backorders,
  // expenses, finance, insights, purchase-orders, smart-layer,
  // stock-adjustments, suppliers) were migrated onto the standard
  // `{ success: false, error: { code, message, details? } }` envelope in
  // #1829 and removed from this list.
]);

function routeFiles(dir: string, rel = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const next = path.join(dir, e.name);
    const relName = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return routeFiles(next, relName);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [relName] : [];
  });
}

/**
 * Strip line comments before matching.
 *
 * `bundle.routes.ts` documents its deliberate flat body in a comment, and the
 * first version of this gate reported it as an offender — a gate failing good
 * work, on a file that is already doing the right thing and explaining why.
 */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

/** Route files that answer with a bare-string error at least once. */
function offenders(): Array<{ file: string; count: number }> {
  return routeFiles(ROUTES)
    .map(f => ({
      file: f,
      count: (
        codeOnly(fs.readFileSync(path.join(ROUTES, f), 'utf-8')).match(BARE_STRING_ERROR) ?? []
      ).length,
    }))
    .filter(x => x.count > 0);
}

describe('bare-string error envelopes are accounted for', () => {
  it('every route file answering with a bare string is registered', () => {
    const unaccounted = offenders()
      .map(x => x.file)
      .filter(f => !(f in DELIBERATE_FLAT_SHAPE) && !UNREVIEWED_PREDATING_THIS_REGISTRY.has(f));

    expect(
      unaccounted,
      'these route files answer `{ error: "CODE" }` — a STRING. Both first-party clients read `data.error?.code`, so the code is invisible and every branch keyed on it is dead (this killed webhook force-replay, reported four times). Move them onto `{ error: { code, message } }`, or register the file with the consumer that depends on the flat shape.'
    ).toEqual([]);
  });

  it('admin.routes.ts is OFF the list — it is the one that was cleaned up', () => {
    // The positive control. A broken regex or an empty file walk would satisfy
    // the assertion above while measuring nothing.
    const files = offenders().map(x => x.file);
    expect(files).not.toContain('admin.routes.ts');
    expect(UNREVIEWED_PREDATING_THIS_REGISTRY.has('admin.routes.ts')).toBe(false);
  });

  it('still finds the offenders that remain — the walk is not silently empty', () => {
    // The other half: if `offenders()` returned [], everything would look
    // accounted for forever.
    expect(offenders().length).toBeGreaterThan(0);
  });

  it('does not list a file that has since been cleaned up', () => {
    // Keeps the ledger honest in the other direction, so the count keeps
    // meaning something.
    const offending = new Set(offenders().map(x => x.file));
    const stale = [...UNREVIEWED_PREDATING_THIS_REGISTRY].filter(f => !offending.has(f));
    expect(stale, 'listed as unreviewed but no longer answer with a bare string').toEqual([]);
  });
});
