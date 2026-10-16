/**
 * `typeof window !== 'undefined' ? window.location.href : ''` at render is '' on the server
 * and the full URL on the client's first render: a hydration mismatch (B0-46,
 * ShareProductRow). Read the URL through `useCurrentUrl()` instead.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (p.endsWith('.tsx') && !/\.test\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

describe('no render-time window.location.href in the storefront', () => {
  it('has zero `typeof window … ? window.location.href` expressions', () => {
    const hits = tsxFiles(join(__dirname, '../../apps/web/src')).filter(f =>
      /typeof window !== ['"]undefined['"]\s*\?\s*window\.location\.href/.test(
        readFileSync(f, 'utf8')
      )
    );
    expect(hits).toEqual([]);
  });
});
