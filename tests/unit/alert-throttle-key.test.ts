import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { throttleKey } from '../../apps/api/src/services/alerts.service';

describe('alert throttle bucket name', () => {
  it('is stable and has the documented shape', () => {
    expect(throttleKey('p1', 'Refund needs review', 's1')).toBe(
      throttleKey('p1', 'Refund needs review', 's1')
    );
    expect(throttleKey('p1', 'Refund needs review', 's1')).toMatch(/^alert-throttle:[0-9a-f]{14}$/);
  });
  it('separates level, title and store (a flapping store A never silences store B)', () => {
    const base = throttleKey('p1', 'Webhook failing', 'storeA');
    expect(throttleKey('p0', 'Webhook failing', 'storeA')).not.toBe(base);
    expect(throttleKey('p1', 'Webhook failing again', 'storeA')).not.toBe(base);
    expect(throttleKey('p1', 'Webhook failing', 'storeB')).not.toBe(base);
    expect(throttleKey('p1', 'Webhook failing')).not.toBe(base);
  });
  it('has no collision across 20000 distinct titles', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(throttleKey('info', `title ${i}`, `store-${i % 37}`));
    expect(seen.size).toBe(20000);
  });
  it('uses no crypto hash (CodeQL js/weak-cryptographic-algorithm + js/insufficient-password-hash on this file)', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/api/src/services/alerts.service.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/createHash|from 'crypto'|from 'node:crypto'/);
  });
});
