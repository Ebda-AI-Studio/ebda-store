/**
 * BuyerIdentity (design review I7, Rulings B2B-2c / B2B-2d): a price identity can only be minted by the three factories in
 * apps/api/src/lib/buyer-identity.ts. Two gates:
 *   1. type level: an object literal, a bare string, a phone or an email is a COMPILE error where a BuyerIdentity is required
 *      (checked with the TypeScript compiler API, so the brand is proven, not assumed);
 *   2. source level: no `kind: 'session' | 'merchant-selected' | 'anonymous'` literal exists anywhere in apps/api/src outside
 *      that one file (a cast `as BuyerIdentity` would need such a literal).
 * The Task 3 architecture test adds "every PriceResolver.forBuyer( argument comes from a factory".
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const API_SRC = resolve(__dirname, '../../apps/api/src');
const IDENTITY_FILE = join(API_SRC, 'lib/buyer-identity.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'node_modules' || e === '__tests__') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('BuyerIdentity cannot be constructed outside its factories', () => {
  it('source: no identity-kind literal exists outside lib/buyer-identity.ts', () => {
    const offenders = walk(API_SRC)
      .filter(f => f !== IDENTITY_FILE)
      .filter(f =>
        /\bkind:\s*['"](session|merchant-selected|anonymous)['"]/.test(readFileSync(f, 'utf8'))
      );
    expect(offenders).toEqual([]);
  });

  it('types: literals, strings and typed identities are compile errors; the factories compile', () => {
    const snippet = join(API_SRC, '__b2b_identity_probe__.ts');
    const code = `
      import type { Request } from 'express';
      import { PriceResolver } from './services/price-resolver.service';
      import { ANONYMOUS_BUYER, buyerFromRequest, buyerFromMerchantSelection } from './lib/buyer-identity';
      declare const req: Request;
      export async function ok() {
        await PriceResolver.forBuyer('s', ANONYMOUS_BUYER);
        await PriceResolver.forBuyer('s', buyerFromRequest(req));
        await PriceResolver.forBuyer('s', buyerFromMerchantSelection(req, 'c'));
      }
      export async function bad1() { await PriceResolver.forBuyer('s', { kind: 'session', userId: 'u' }); }
      export async function bad2() { await PriceResolver.forBuyer('s', 'user-id'); }
      export async function bad3() { await PriceResolver.forBuyer('s', { phone: '+201000000000' }); }
      export async function bad4() { await PriceResolver.forBuyer('s', { kind: 'anonymous' }); }
      export async function bad5() { await PriceResolver.forBuyer('s', null); }
    `;
    const cfgPath = resolve(__dirname, '../../apps/api/tsconfig.json');
    const cfg = ts.getParsedCommandLineOfConfigFile(
      cfgPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => undefined,
      }
    )!;
    const host = ts.createCompilerHost(cfg.options);
    const realRead = host.readFile.bind(host);
    const realExists = host.fileExists.bind(host);
    host.readFile = f => (f === snippet ? code : realRead(f));
    host.fileExists = f => f === snippet || realExists(f);
    const sourceFileOf = host.getSourceFile.bind(host);
    host.getSourceFile = (f, lang, ...rest) =>
      f === snippet ? ts.createSourceFile(f, code, lang) : sourceFileOf(f, lang, ...rest);
    const program = ts.createProgram([snippet], { ...cfg.options, noEmit: true }, host);
    const diags = ts
      .getPreEmitDiagnostics(program, program.getSourceFile(snippet))
      .filter(d => d.file?.fileName === snippet);
    const lines = diags.map(d => ts.getLineAndCharacterOfPosition(d.file!, d.start!).line + 1);
    const lineOf = (needle: string) => code.split('\n').findIndex(l => l.includes(needle)) + 1;
    expect(lines.sort()).toEqual(
      ['bad1', 'bad2', 'bad3', 'bad4', 'bad5'].map(n => lineOf(`function ${n}`)).sort()
    );
  }, 60_000);
});
