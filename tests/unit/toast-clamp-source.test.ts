/** A success toast clamps its message to two lines; an error or warning is never cut (Ruling B3-16, review M3). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Toast message clamp', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../packages/ui/src/components/Toast/index.tsx'),
    'utf8'
  );
  it("clamps only a 'success' toast", () => {
    expect(src).toMatch(/toast\.type === 'success' \? 'line-clamp-2' : ''/);
    expect(src).not.toMatch(/leading-relaxed line-clamp-2/);
  });
});
