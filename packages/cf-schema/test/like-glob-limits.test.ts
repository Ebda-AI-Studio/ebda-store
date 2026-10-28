// workerd rejects a LIKE/GLOB pattern longer than 50 bytes when the statement RUNS ("pattern too complex"),
// so an oversize CHECK is invisible to node:sqlite and fails every insert on a real Durable Object
// (2026-10-25: product_option_values_swatch_hex_format, a 67-byte GLOB). Same limit as generate.mjs asserts.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrationFiles, openDb } from './helpers';

describe('LIKE / GLOB pattern length', () => {
  it('no shipped migration holds a pattern over 50 bytes', () => {
    const over: string[] = [];
    for (const target of ['store', 'platform'] as const)
      for (const f of migrationFiles(target))
        for (const m of fs
          .readFileSync(f, 'utf8')
          .matchAll(/\b(?:NOT\s+)?(?:GLOB|LIKE)\s+'((?:[^']|'')*)'/gi))
          if (Buffer.byteLength(m[1].replace(/''/g, "'")) > 50) over.push(`${f}: ${m[0]}`);
    expect(over).toEqual([]);
  });

  it('the swatch hex CHECK still accepts #rrggbb in either case and refuses everything else', () => {
    const db = openDb('store');
    const ok = (hex: string | null) => {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`DELETE FROM product_option_values`);
      db.prepare(
        `INSERT INTO product_option_values (id, option_id, value, swatch_hex) VALUES ('v', 'o', 'x', ?)`
      ).run(hex);
    };
    for (const good of ['#a1b2c3', '#A1B2C3', '#aBc123', null])
      expect(() => ok(good), String(good)).not.toThrow();
    for (const bad of ['#a1b2c', '#a1b2c3d', 'a1b2c3d', '#g1b2c3', '# 1b2c3', '#a1b2c3\n'])
      expect(() => ok(bad), bad).toThrow(/CHECK/);
  });
});
