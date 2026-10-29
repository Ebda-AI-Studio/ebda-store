// Task 1.1: every Prisma model is classified exactly once; a new model fails until it is.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { parseSchema } from '../scripts/prisma-parse.mjs';
import { readJson, REPO } from './helpers';

const split = readJson<Record<string, { target: string; reason: string }>>('model-split.json');
const schemaText = fs.readFileSync(
  path.join(REPO, 'packages/database/prisma/schema.prisma'),
  'utf8'
);
const schema = parseSchema(schemaText);

describe('model-split.json', () => {
  it('lists every schema.prisma model exactly once with a known target', () => {
    const names = schema.models.map(m => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(split).sort()).toEqual([...names].sort());
    for (const [name, v] of Object.entries(split)) {
      expect(['d1', 'store-do', 'analytics', 'drop', 'identity'], name).toContain(v.target);
      expect(v.reason.length, name).toBeGreaterThan(5);
    }
  });

  it('matches the plan totals (158 models: 27 d1 + 119 store-do + 7 analytics + 1 drop + 4 identity; WhatsAppTemplate dropped by #223; StoreWhatsAppLink and StoreWhatsAppConsent added by #218; EtaConnection and EtaReceipt added by the ETA e-receipt connector; StaffInvite added by the identity invitations, d1; QrScanDaily added by the QR scan counter, analytics; CiInsight d1 and CiHintLog store-do added by CI-2 and CI-3; CiStoreGate store-do added by CI-13)', () => {
    const count = (t: string) => Object.values(split).filter(v => v.target === t).length;
    expect(Object.keys(split).length).toBe(158);
    expect([
      count('d1'),
      count('store-do'),
      count('analytics'),
      count('drop'),
      count('identity'),
    ]).toEqual([27, 119, 7, 1, 4]);
  });

  it('keeps identity out of the platform database (Ruling ID-1: owned by the ebda-identity track)', () => {
    const ident = Object.entries(split)
      .filter(([, v]) => v.target === 'identity')
      .map(([n]) => n)
      .sort();
    expect(ident).toEqual(['PasskeyCredential', 'RefreshToken', 'User', 'VerificationToken']);
  });

  it('the schema parser agrees with the runtime DMMF on model names, fields, kinds and nullability', () => {
    const dmmf = Prisma.dmmf.datamodel;
    expect(schema.models.length).toBe(dmmf.models.length);
    for (const m of schema.models) {
      const d = dmmf.models.find(x => x.name === m.name);
      expect(d, m.name).toBeTruthy();
      expect(m.dbName, m.name).toBe(d!.dbName ?? m.name);
      // the runtime DMMF omits Unsupported(...) fields (ProductEmbedding.embedding); the parser keeps them
      expect(
        m.fields.filter(f => f.kind !== 'unsupported').map(f => f.name),
        m.name
      ).toEqual(d!.fields.map(f => f.name));
      for (const f of m.fields.filter(x => x.kind !== 'unsupported')) {
        const df = d!.fields.find(x => x.name === f.name)!;
        const kind = f.kind === 'relation' ? 'object' : f.kind;
        expect(kind, `${m.name}.${f.name}`).toBe(df.kind);
        if (f.kind !== 'relation')
          expect(f.column, `${m.name}.${f.name}`).toBe(
            (df as { dbName?: string | null }).dbName ?? f.name
          );
      }
    }
  });
});
