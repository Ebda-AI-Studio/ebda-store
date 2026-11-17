/** The developer docs must describe what the code does (review M5, M6, M11). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const page = read('apps/docs/content/merchant-webhooks.mdx');

describe('merchant webhooks docs match reality', () => {
  it('M5: does not promise a Resend for events that happened while the endpoint was off (none are stored)', () => {
    expect(page).not.toMatch(/while it was off[^.]*Resend/i);
    expect(page).toMatch(/not (re-sent|stored|kept)/i);
    expect(page).toMatch(/GET|delivery log/i);
  });
  it('M6: every reference to the receiver docs points at the real page', () => {
    for (const f of [
      'packages/shared/src/schemas/webhook.ts',
      'apps/api/src/services/webhook-payload.ts',
      'docs/plans/done/2026-10-21-merchant-webhooks.md',
    ]) {
      expect(read(f), f).not.toContain('docs/developers/webhooks.md');
      expect(read(f), f).toContain('apps/docs/content/merchant-webhooks.mdx');
    }
  });
  it('M11: states the rebinding residual honestly (a 200 character read, bounded by Workers)', () => {
    const wh6 = read('docs/rulings/WH-6.md');
    expect(wh6).toMatch(/200[- ]character/);
    expect(wh6).not.toMatch(/not a read oracle|one blind POST/i);
    expect(wh6).toMatch(/Workers/);
    expect(wh6).toMatch(/Node/);
  });
});
