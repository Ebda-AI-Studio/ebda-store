import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Defect class (PR #791): on D1 `meta.changes` / the prisma-lite `count` INCLUDES rows written by triggers (and on a Durable Object
// `rowsWritten` includes index + trigger rows), so `changes === 1` / `count !== 1` as a "I won the claim" test can make every claimant
// lose. Win test for a single-row claim = `changes > 0`. prisma-lite's `count` is a row count (safe); raw D1 `meta.changes` and DO `run().changes` are the values at risk (do-runner.ts statementChanges). This guard is a RATCHET: the exact-one comparisons that exist
// today were each reviewed and are correct (no row-writing trigger on the table, or a DO-local `SELECT changes()`); a NEW one fails
// here. Escape: put `// d1-exact-ok: <why this is exactly one row>` on the same or the previous line, or lower-and-fix.
const ROOT = resolve(__dirname, '../..');
const SCOPE = ['apps/api/src', 'apps/accounts/src', 'packages/repo/src'];
const EXACT = /\b(?:changes|count|rowsAffected|changedRows)\b[^;\n]*?(===|!==|==|!=)\s*1(?![0-9.])/;
const WRITE = /\.meta\??\.changes|\.changes\b|\bcount\b|rowsAffected|changedRows|\bchanges\b/;
const SKIP = /\.(test|spec)\.|\/workers-|\/stubs\/|\.d\.ts$|redis\.service|\/templates\//;

function scan(files: string[], read: (f: string) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '');
      if (!EXACT.test(code) || !WRITE.test(code)) return;
      if (/d1-exact-ok:/.test(l) || /d1-exact-ok:/.test(lines[i - 1] ?? '')) return;
      out[f] = (out[f] ?? 0) + 1;
    });
  }
  return out;
}

const BASELINE: Record<string, number> = {
  'apps/accounts/src/app.ts': 3,
  'apps/accounts/src/data.ts': 2,
  'apps/accounts/src/mfa-keys.ts': 1,
  'apps/accounts/src/otp.ts': 2,
  'apps/accounts/src/passkeys.ts': 3,
  'apps/api/src/lib/inngest/functions/campaign-send.ts': 1,
  'apps/api/src/routes/staff-invite.routes.ts': 1,
  'apps/api/src/services/accounting/purchase-order.service.ts': 4,
  'apps/api/src/services/accounting/stock-adjustment.service.ts': 3,
  'apps/api/src/services/affiliate.service.ts': 3,
  'apps/api/src/services/auth.service.ts': 1,
  'apps/api/src/services/billing/comp-migration.ts': 1,
  'apps/api/src/services/billing/grants.service.ts': 3,
  'apps/api/src/services/billing/subscription-billing.service.ts': 6,
  'apps/api/src/services/cart-recovery-email.service.ts': 1,
  'apps/api/src/services/catalog-import.service.ts': 2,
  'apps/api/src/services/legal-notice.service.ts': 2,
  'apps/api/src/services/lifecycle-emails.service.ts': 1,
  'apps/api/src/services/page-builder.service.ts': 3,
  'apps/api/src/services/passkey.service.ts': 3,
  'apps/api/src/services/payment-providers/instapay.service.ts': 2,
  'apps/api/src/services/payment-state-claims.ts': 3,
  'apps/api/src/services/plan-limit.service.ts': 1,
  'apps/api/src/services/platform/access-d1.ts': 4,
  'apps/api/src/services/platform/billing-d1.ts': 3,
  'apps/api/src/services/provider-verification.service.ts': 2,
  'apps/api/src/services/pwa.service.ts': 1,
  'apps/api/src/services/return.service.ts': 1,
  'apps/api/src/services/shipment-pickup.service.ts': 1,
  'apps/api/src/services/shipping-carrier.service.ts': 3,
  'apps/api/src/services/webhook.service.ts': 1,
  'packages/repo/src/do/customer-auth.ts': 2,
  'packages/repo/src/do/job-ops.ts': 1,
  'packages/repo/src/do/stock-books.ts': 2,
  'packages/repo/src/do/stock-ops.ts': 1,
  'packages/repo/src/prisma-lite/do-runner.ts': 1,
  'packages/repo/src/rpc/writes.ts': 1,
};

describe('D1 exact-one write-count guard', () => {
  it('flags a new `changes === 1`-style comparison', () => {
    const fake = {
      'a.ts':
        'if (r.meta.changes === 1) win();\nif (count !== 1) return;\n// d1-exact-ok: unique key\nif (x.changes === 1) ok();\nif (n > 0) ok();',
    };
    expect(scan(['a.ts'], f => fake[f as 'a.ts'])).toEqual({ 'a.ts': 2 });
  });

  it('no file gains an exact-one comparison over the reviewed baseline', () => {
    const files = execFileSync(
      'git',
      ['ls-files', ...SCOPE.map(s => `${s}/*.ts`), ...SCOPE.map(s => `${s}/**/*.ts`)],
      { cwd: ROOT, encoding: 'utf8' }
    )
      .split('\n')
      .filter(f => f && !SKIP.test(f));
    const found = scan([...new Set(files)], f => readFileSync(resolve(ROOT, f), 'utf8'));
    const over = Object.entries(found).filter(([f, n]) => n > (BASELINE[f] ?? 0));
    expect(over, 'use `changes > 0` or annotate `// d1-exact-ok: <reason>`').toEqual([]);
  });
});
