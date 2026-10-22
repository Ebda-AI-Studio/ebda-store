/**
 * The gate that stops the next form from reintroducing the bug.
 *
 * `scripts/check-update-payload-clear.mjs` runs in CI's Lint job. It must
 * FAIL on a reintroduced `X || undefined` inside an update payload, and it
 * must PASS on the two shapes where `undefined` is correct — otherwise it
 * gets disabled within a week and stops being a gate at all:
 *
 *   - CREATE paths (`apiPost`): there is nothing to clear, and `undefined`
 *     lets the API/Prisma column default apply.
 *   - inherit-default patches of a locally-held config object that the server
 *     REPLACES wholesale (the page builder's ~26 layout-section patches, the
 *     floating widget config): dropping the key IS the reset-to-default.
 */

import { describe, it, expect } from 'vitest';
import {
  findClearGateViolations,
  scanRepo,
  SCAN_ROOTS,
} from '../../scripts/check-update-payload-clear.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('clear-on-empty gate — FAILS on a reintroduced violation', () => {
  it('flags the exact shape that shipped the order-invoice bug', () => {
    const src = `
      await apiPut(\`/api/v1/stores/\${storeId}\`, {
        settings: {
          ...existingSettings,
          orderInvoiceEmail: orderInvoiceEmail.trim() || undefined,
        },
      });
    `;
    const found = findClearGateViolations(src, 'delivery/page.tsx');
    expect(found).toHaveLength(1);
    expect(found[0].call).toBe('apiPut');
    expect(found[0].snippet).toContain('|| undefined');
  });

  it('flags a top-level update payload key', () => {
    const src = `apiPut(url, { nameAr: form.nameAr || undefined });`;
    expect(findClearGateViolations(src, 'a.tsx')).toHaveLength(1);
  });

  it('flags apiPatch the same way, and counts every offending key', () => {
    const src = `
      apiPatch(url, {
        description: form.description || undefined,
        sku: form.sku || undefined,
      });
    `;
    expect(findClearGateViolations(src, 'a.tsx')).toHaveLength(2);
  });

  it('issue 2262: flags the ternary spelling `cond ? x : undefined` (and the mirrored form)', () => {
    const src = `
      apiPatch(url, {
        customTermsDays: terms === 'custom' && days ? parseInt(days) : undefined,
        leadTime: hasLead ? undefined : lead,
      });
    `;
    const found = findClearGateViolations(src, 'a.tsx');
    expect(found).toHaveLength(2);
    expect(found[0].snippet).toContain(': undefined');
  });

  it('issue 2262: a ternary with no undefined branch is not flagged', () => {
    const src = `apiPatch(url, { customTermsDays: custom ? parseInt(days) : null });`;
    expect(findClearGateViolations(src, 'a.tsx')).toEqual([]);
  });

  it('flags it however deeply nested in the body', () => {
    const src = `apiPut(url, { a: { b: { c: { d: v || undefined } } } });`;
    expect(findClearGateViolations(src, 'a.tsx')).toHaveLength(1);
  });

  it('#1576: flags a payload built one statement earlier and passed by identifier', () => {
    // `apiPut(url, body)` — the object literal has no children for
    // scanArgument to recurse into, since the call site holds only an
    // identifier. Every surface this class of fix actually shipped on used
    // exactly this shape.
    const src = `
      const body = { x: v || undefined };
      apiPut(url, body);
    `;
    const found = findClearGateViolations(src, 'a.tsx');
    expect(found).toHaveLength(1);
    expect(found[0].snippet).toContain('|| undefined');
  });

  it('#1576: resolves the identifier for apiPatch too, and across multiple keys', () => {
    const src = `
      const payload = {
        name: name.trim(),
        nameAr: nameAr.trim() || undefined,
        notes: notes.trim() || undefined,
      };
      apiPatch(url, payload);
    `;
    expect(findClearGateViolations(src, 'a.tsx')).toHaveLength(2);
  });

  it('#1576: does not guess when the identifier is ambiguous (two same-named locals in one scope)', () => {
    // Deliberately conservative: block-scoped `const body` in each branch of
    // one function is two declarations within the SAME enclosing function
    // scope this gate searches. It must never guess which one `apiPut`
    // actually received and produce a false positive on the wrong one.
    const src = `
      function handleSubmit() {
        if (cond) {
          const body = { x: 1 };
          apiPut(url, body);
        } else {
          const body = { y: v || undefined };
        }
      }
    `;
    expect(findClearGateViolations(src, 'a.tsx')).toHaveLength(0);
  });

  it('#1576: does not resolve an identifier with no matching declaration in scope', () => {
    const src = `apiPut(url, someImportedConstant);`;
    expect(findClearGateViolations(src, 'a.tsx')).toHaveLength(0);
  });
});

describe('clear-on-empty gate — PASSES on the legitimate uses', () => {
  it('ignores the create path', () => {
    const src = `
      apiPost(\`/api/v1/stores/\${storeId}/affiliates\`, {
        name: inviteName.trim(),
        phone: invitePhone.trim() || undefined,
      });
    `;
    expect(findClearGateViolations(src, 'affiliates/page.tsx')).toHaveLength(0);
  });

  it("ignores the visual editor's inherit-default section patches", () => {
    const src = `
      <input onChange={e => onPatch({ categorySlug: e.target.value || undefined })} />
    `;
    expect(findClearGateViolations(src, 'builder/_components/SettingsPanel.tsx')).toHaveLength(0);
  });

  it("ignores the floating widget's local config patches", () => {
    const src = `
      <ColorField onChange={v => patch({ toggleBgColor: v || undefined })} />
    `;
    expect(findClearGateViolations(src, 'floating-widget/page.tsx')).toHaveLength(0);
  });

  it('ignores a React prop and a plain local variable', () => {
    const src = `
      const heroImage = store.heroImage || undefined;
      const el = <ImageField value={row.imageUrl || undefined} />;
    `;
    expect(findClearGateViolations(src, 'a.tsx')).toHaveLength(0);
  });

  it('accepts the correct null form', () => {
    const src = `apiPut(url, { nameAr: textFieldValue(form.nameAr, 'update') });`;
    expect(findClearGateViolations(src, 'a.tsx')).toHaveLength(0);
  });

  it('honours a documented waiver on the line or in the comment block above', () => {
    const inline = `apiPut(url, { apiKey: apiKey || undefined }); // clear-gate-allow: no null form`;
    expect(findClearGateViolations(inline, 'a.tsx')).toHaveLength(0);

    const block = `
      apiPut(url, {
        // clear-gate-allow: the provider API has no clear form for a stored
        // key, so an empty field must mean "leave it alone".
        apiKey: apiKey || undefined,
      });
    `;
    expect(findClearGateViolations(block, 'a.tsx')).toHaveLength(0);
  });

  it('does not treat an unrelated earlier comment as a waiver', () => {
    const src = `
      // clear-gate-allow: this waiver belongs to something else
      const other = 1;
      apiPut(url, { nameAr: form.nameAr || undefined });
    `;
    expect(findClearGateViolations(src, 'a.tsx')).toHaveLength(1);
  });
});

describe('clear-on-empty gate — the repo is currently clean', () => {
  it('finds no unwaived violation across the scanned app roots', () => {
    expect(SCAN_ROOTS).toContain('apps/admin/src');
    expect(scanRepo(REPO_ROOT)).toEqual([]);
  });
});
