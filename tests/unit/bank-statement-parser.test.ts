// ACCT-AUDIT-8: the bank CSV parser on the Egyptian export shapes the audit measured (comma decimal, Arabic headers with
// the definite article, windows-1256 bytes, a bank preamble above the header).
import { describe, expect, it } from 'vitest';
import {
  decimalStringToFils,
  parseStatementCsv,
  parseStatementOfx,
} from '@api/services/accounting/bank-statement-parser';

const utf8 = (s: string) => Buffer.from(s, 'utf-8');
/** Encode text as windows-1256 by inverting the decoder, so the test needs no iconv dependency. */
function cp1256(s: string): Buffer {
  const dec = new TextDecoder('windows-1256');
  const inv = new Map<string, number>();
  for (let b = 0; b < 256; b++) inv.set(dec.decode(Uint8Array.of(b)), b);
  return Buffer.from([...s].map(ch => inv.get(ch) ?? 63));
}

describe('decimalStringToFils: separators', () => {
  it.each([
    ['100,50', 10050],
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    ['1,234', 123400],
    ['12.34', 1234],
    ['-0,50', -50],
    ['1.234.567', 123456700],
    ['١٢٣,٤٥', 12345],
    ['0', 0],
  ])('%s -> %i piastres', (raw, want) => {
    expect(decimalStringToFils(raw)).toBe(want);
  });
});

describe('parseStatementCsv: Egyptian export shapes', () => {
  it('a semicolon file with a comma decimal reads 100,50 as 100.50 EGP, not 10,050.00', () => {
    const r = parseStatementCsv(
      utf8('date;description;amount\n2026-11-01;Sale;100,50\n2026-11-02;Fee;-5,25')
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map(x => [x.amountFils, x.direction])).toEqual([
      [10050, 'credit'],
      [525, 'debit'],
    ]);
  });

  it('Arabic headers with the definite article (التاريخ, الوصف, مدين, دائن) are recognised', () => {
    const r = parseStatementCsv(
      utf8('التاريخ,الوصف,مدين,دائن\n2026-11-01,مبيعات,,250.00\n2026-11-02,إيجار,900.00,')
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map(x => [x.description, x.amountFils, x.direction])).toEqual([
      ['مبيعات', 25000, 'credit'],
      ['إيجار', 90000, 'debit'],
    ]);
  });

  it('a windows-1256 export keeps its Arabic descriptions (no U+FFFD)', () => {
    const r = parseStatementCsv(cp1256('التاريخ,الوصف,مدين,دائن\n2026-11-01,مبيعات الشهر,,250.00'));
    expect(r.errors).toEqual([]);
    expect(r.rows[0].description).toBe('مبيعات الشهر');
  });

  it('a UTF-8 file is not mistaken for windows-1256', () => {
    const r = parseStatementCsv(utf8('date,description,amount\n2026-11-01,café é,10.00'));
    expect(r.rows[0].description).toBe('café é');
  });

  it('a bank preamble above the header is skipped', () => {
    const r = parseStatementCsv(
      utf8(
        'Banque Misr statement\nAccount: 123;456\nPeriod: Nov 2026\n\ndate,description,debit,credit\n2026-11-01,POS,10.00,\n2026-11-02,Transfer,,20.00'
      )
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map(x => x.amountFils)).toEqual([1000, 2000]);
  });

  it('a file with no header anywhere still reports the missing column', () => {
    expect(parseStatementCsv(utf8('hello\nworld')).errors[0]).toMatch(/date column/);
  });
});

describe('row hashes (ACCT-AUDIT-6)', () => {
  const file =
    'date,description,amount\n2026-11-01,POS purchase,-50.00\n2026-11-01,POS purchase,-50.00\n2026-11-01,POS purchase,-50.00\n2026-11-02,Other,10.00';
  it('identical lines in one file are separate transactions with distinct hashes', () => {
    const r = parseStatementCsv(utf8(file));
    expect(r.rows).toHaveLength(4);
    expect(new Set(r.rows.map(x => x.rowHash)).size).toBe(4);
  });
  it('a re-upload of the same file hashes every row the same', () => {
    const a = parseStatementCsv(utf8(file)).rows.map(x => x.rowHash);
    const b = parseStatementCsv(utf8(file)).rows.map(x => x.rowHash);
    expect(b).toEqual(a);
  });
  it('the first occurrence keeps the hash it had before ordinals, so earlier imports still match', () => {
    const one = parseStatementCsv(utf8('date,description,amount\n2026-11-01,POS purchase,-50.00'))
      .rows[0];
    const three = parseStatementCsv(utf8(file)).rows[0];
    expect(three.rowHash).toBe(one.rowHash);
  });
  it('OFX lines without a FITID repeat the same way', () => {
    const tx = '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261101<TRNAMT>-50.00<NAME>POS</STMTTRN>';
    const r = parseStatementOfx(Buffer.from(`<OFX><BANKTRANLIST>${tx}${tx}</BANKTRANLIST></OFX>`));
    expect(new Set(r.rows.map(x => x.rowHash)).size).toBe(2);
  });
});
