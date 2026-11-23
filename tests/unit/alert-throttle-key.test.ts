import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { throttleKey } from '../../apps/api/src/services/alerts.service';

describe('alert throttle bucket name', () => {
  it('is stable', () => {
    expect(throttleKey('p1', 'Refund needs review', 's1')).toBe(
      throttleKey('p1', 'Refund needs review', 's1')
    );
  });
  it('separates level, title and store (a flapping store A never silences store B)', () => {
    const base = throttleKey('p1', 'Webhook failing', 'storeA');
    expect(throttleKey('p0', 'Webhook failing', 'storeA')).not.toBe(base);
    expect(throttleKey('p1', 'Webhook failing again', 'storeA')).not.toBe(base);
    expect(throttleKey('p1', 'Webhook failing', 'storeB')).not.toBe(base);
    expect(throttleKey('p1', 'Webhook failing')).not.toBe(base);
  });
  it('two different titles never share a key, however crafted (no truncation, no hash)', () => {
    const real = 'Refund needs review';
    expect(throttleKey('p1', `${real} `)).not.toBe(throttleKey('p1', real));
    expect(throttleKey('p1', 'x'.repeat(500) + 'a')).not.toBe(
      throttleKey('p1', 'x'.repeat(500) + 'b')
    );
    // fields cannot spill into each other: store "a" + title "5:abc..." vs store "a:5" + shifted title
    expect(throttleKey('p1', '3:abc', 'a')).not.toBe(throttleKey('p1', 'abc', 'a:3'));
    expect(throttleKey('p1', 'b:1:c', 'a')).not.toBe(throttleKey('p1', 'c', 'a:1:b'));
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
