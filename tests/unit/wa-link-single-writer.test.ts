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
  it('only lib/wa/link.ts references the model', () => {
    const users = walk(SRC).filter(f =>
      /storeWhatsAppLink|store_whatsapp_links/.test(readFileSync(f, 'utf8'))
    );
    expect(users.map(f => path.relative(SRC, f))).toEqual(['lib/wa/link.ts']);
  });
  it('nothing reads settings.ebdaWhatsApp', () => {
    const users = walk(SRC).filter(f =>
      /settings[^\n]{0,40}ebdaWhatsApp|\.ebdaWhatsApp/.test(readFileSync(f, 'utf8'))
    );
    expect(users).toEqual([]);
  });
});
