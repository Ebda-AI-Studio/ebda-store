/**
 * One layer owns the write: `store_whatsapp_links` is written only by lib/wa/link.ts. No route,
 * service or job may touch the model, so no request handler can set the link.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../apps/api/src');
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('store_whatsapp_links single writer', () => {
  it('only lib/wa/link.ts WRITES the model (reads, e.g. the plan-sync sweep, are fine)', () => {
    const writers = walk(SRC).filter(f => {
      const t = readFileSync(f, 'utf8');
      return (
        /storeWhatsAppLink\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(
          t
        ) || /(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?store_whatsapp_links/.test(t)
      );
    });
    expect(writers.map(f => path.relative(SRC, f))).toEqual(['lib/wa/link.ts']);
  });
  it('nothing reads settings.ebdaWhatsApp', () => {
    const users = walk(SRC).filter(f =>
      /settings[^\n]{0,40}ebdaWhatsApp|\.ebdaWhatsApp/.test(readFileSync(f, 'utf8'))
    );
    expect(users).toEqual([]);
  });
});
