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
// Auth middleware answers requests directly (it can reject BEFORE a route
// handler ever runs), so a bare-string error there is invisible to the same
// client code the routes-only walk was checking — `wa-bridge-auth.ts`
// (#1824) predates this registry the same way a routes file would.
const MIDDLEWARE = path.resolve(__dirname, '../../apps/api/src/middleware');

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
  'wa-bridge-auth.ts':
    'same WBS bridge, one layer earlier — this middleware rejects the request before a wa-bridge.routes.ts handler ever runs, for the same external, not-in-this-repo consumer',
};

/**
 * Files that predate this registry and have NOT been checked for a consumer.
 *
 * This list is the finding, not the fix. Every entry removed from it is either
 * cleaned up or moved above with a reason. Do not add to it.
 *
 * The value PINS THE EXACT COUNT of bare-string errors measured in that file
 * when it was listed. A bare Set only records file MEMBERSHIP, so a new,
 * unreviewed bare-string error added to a file that is already on this list
 * (e.g. one more `error: 'CODE'` in finance.routes.ts) stayed invisible —
 * the file was already "accounted for". The count assertion below fails if
 * any listed file's count goes UP.
 */
const UNREVIEWED_PREDATING_THIS_REGISTRY: Record<string, number> = {
  'wa-templates.routes.ts': 10,
  'public.routes.ts': 9,
  'inventory.routes.ts': 6,
  // The accounting / finance / insights surfaces (alert-webhooks, backorders,
  // expenses, finance, insights, purchase-orders, smart-layer,
  // stock-adjustments, suppliers) and payment-links.routes.ts shared a
  // DIFFERENT convention — a flat lower-case discriminant
  // (`{ error: 'not_found' }`, `{ error: 'validation_failed', details }`) —
  // and were migrated onto the standard
  // `{ success: false, error: { code, message, details? } }` envelope in
  // #1829, so they are removed from this list rather than merely reasoned
  // about. See docs/RULINGS.md Ruling P2-B8-1's correction for why the
  // "their own pages read it as a string" deferral did not hold for most of
  // this group in the first place.
};

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

/** Route AND auth-middleware files that answer with a bare-string error at least once. */
function offenders(): Array<{ file: string; count: number }> {
  return [ROUTES, MIDDLEWARE].flatMap(root =>
    routeFiles(root)
      .map(f => ({
        file: f,
        count: (
          codeOnly(fs.readFileSync(path.join(root, f), 'utf-8')).match(BARE_STRING_ERROR) ?? []
        ).length,
      }))
      .filter(x => x.count > 0)
  );
}

describe('bare-string error envelopes are accounted for', () => {
  it('every route file answering with a bare string is registered', () => {
    const unaccounted = offenders()
      .map(x => x.file)
      .filter(f => !(f in DELIBERATE_FLAT_SHAPE) && !(f in UNREVIEWED_PREDATING_THIS_REGISTRY));

    expect(
      unaccounted,
      'these route files answer `{ error: "CODE" }` — a STRING. Both first-party clients read `data.error?.code`, so the code is invisible and every branch keyed on it is dead (this killed webhook force-replay, reported four times). Move them onto `{ error: { code, message } }`, or register the file with the consumer that depends on the flat shape.'
    ).toEqual([]);
  });

  it('no listed file grew a NEW bare-string error since it was counted', () => {
    // Membership alone (a bare Set) hid a second, unreviewed offence added to
    // a file that was already "accounted for" by being on the list. Pin the
    // exact count so it can't.
    const grown = offenders().filter(
      x =>
        x.file in UNREVIEWED_PREDATING_THIS_REGISTRY &&
        x.count > UNREVIEWED_PREDATING_THIS_REGISTRY[x.file]
    );
    expect(
      grown,
      'these files gained a NEW bare-string error beyond the count pinned when they were listed as unreviewed — that new one was never looked at'
    ).toEqual([]);
  });

  it('admin.routes.ts is OFF the list — it is the one that was cleaned up', () => {
    // The positive control. A broken regex or an empty file walk would satisfy
    // the assertion above while measuring nothing.
    const files = offenders().map(x => x.file);
    expect(files).not.toContain('admin.routes.ts');
    expect('admin.routes.ts' in UNREVIEWED_PREDATING_THIS_REGISTRY).toBe(false);
  });

  it('still finds the offenders that remain — the walk is not silently empty', () => {
    // The other half: if `offenders()` returned [], everything would look
    // accounted for forever.
    expect(offenders().length).toBeGreaterThan(0);
  });

  it('does not list a file that has since been cleaned up', () => {
    // Keeps the ledger honest in the other direction, so the count keeps
    // meaning something.
    const offending = new Map(offenders().map(x => [x.file, x.count]));
    const stale = Object.keys(UNREVIEWED_PREDATING_THIS_REGISTRY).filter(f => !offending.has(f));
    expect(stale, 'listed as unreviewed but no longer answer with a bare string').toEqual([]);
  });

  it('pins the CSRF rejection to the object envelope the storefront self-heal contract reads', () => {
    // apps/web/src/lib/api.ts's silent-refresh-and-retry contract reads
    // `peek?.error?.code.startsWith('CSRF_')` on a 403 — that only works if
    // `middleware/security.ts` answers CSRF failures with the OBJECT shape.
    // Nothing else in this file's `offenders()` walk would catch a
    // regression here: security.ts isn't a routes file, and its `error:`
    // values are already objects, not bare strings, so BARE_STRING_ERROR
    // never matches it either way. This is a positive assertion, not an
    // absence-of-offender check.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../apps/api/src/middleware/security.ts'),
      'utf-8'
    );
    const csrfRejections = [...src.matchAll(/error:\s*\{\s*code:\s*'(CSRF_[A-Z_]+)'/g)].map(
      m => m[1]
    );
    expect(csrfRejections, 'no CSRF_* object-shaped rejection found in security.ts').not.toEqual(
      []
    );
    expect(csrfRejections).toContain('CSRF_INVALID');
  });
});
