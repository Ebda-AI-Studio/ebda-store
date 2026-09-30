/**
 * audit-followup #1872: after a successful erase, `handleEraseConfirm` used
 * to `await fetchDetail()`. `eraseAccount` (auth.service.ts) nulls
 * `order.customerId` and overwrites `shippingAddress`/`billingAddress` with
 * `{anonymized:true}`; the GET route (customers.routes.ts) matches a
 * customer only by `customerId` OR `shippingAddress.email`/`phone` — both
 * scrubbed — so the re-fetch 404s every time. The merchant saw a success
 * toast immediately followed by an error banner over the stale pre-erase
 * PII still sitting in `customer` state (never cleared on the error path).
 *
 * There is no DOM harness in this repo (see `apps/web/src/lib/
 * bundles-nav.ts`'s doc comment / `ItemsCard.test.ts` for the same
 * rationale) to render this page and click through the erase flow, so —
 * matching that established pattern — this asserts on the component
 * SOURCE: the handler must navigate away, never re-fetch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('CustomerDetailPage.handleEraseConfirm does not re-fetch the erased customer', () => {
  const source = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
  const handlerStart = source.indexOf('const handleEraseConfirm');
  const handlerEnd = source.indexOf('const displayName');

  it('locates the handler in the source (sanity check for the slice below)', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
  });

  const handlerBody = source.slice(handlerStart, handlerEnd);

  it('does not call fetchDetail() on the success path (would 404 over stale PII)', () => {
    expect(handlerBody).not.toContain('fetchDetail()');
  });

  it('navigates back to the customers list instead', () => {
    expect(handlerBody).toMatch(/router\.push\(\s*`\/stores\/\$\{storeId\}\/customers/);
  });

  it('#2229 — an ambiguous CRM match: a toast that stays + the review banner param', () => {
    expect(handlerBody).toMatch(/duration:\s*0/);
    expect(handlerBody).toContain('ERASURE_REVIEW_PARAM');
  });
});
