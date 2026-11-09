/**
 * 2026-11-09 P1 class guard: the StoreDO read client THROWS on any `$`-prefixed member (packages/repo/src/rpc/client.ts), so a
 * feature probe such as `typeof tx.$queryRaw` crashes exactly the client it was meant to detect (stock-reorder-scan). Code decides
 * the DO path from the money/stock client or the repo backend, never by touching a `$` member of a client.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const API = path.resolve(__dirname, '../../apps/api/src');
const PROBE =
  /(?:typeof\s+\w+(?:\.\w+)*\.\$(?:queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe|transaction)\b|['"]\$(?:queryRaw|executeRaw)['"]\s+in\s)/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return files(p);
    return /\.ts$/.test(d.name) ? [p] : [];
  });
}

describe('no `$`-member probe on a client that may be the DO read client', () => {
  it('finds none in apps/api/src', () => {
    const hits = files(API).filter(f => PROBE.test(fs.readFileSync(f, 'utf8')));
    expect(hits.map(f => path.relative(API, f))).toEqual([]);
  });
  it('the pattern is not blind', () => {
    expect(PROBE.test('if (typeof tx.$queryRaw !== "function") {}')).toBe(true);
  });
});
