// Search eval harness (Task 13): the scoring math and the SEARCH-10 pass bar, no DB, no network.
import { describe, it, expect } from 'vitest';
import { normalizeArabicSearch } from '../../packages/shared/src/search/arabic-normalize';
import {
  hitAt,
  reciprocalRank,
  ndcgAt,
  hybridVariant,
  summarise,
  passBar,
  type QueryScore,
  type Summary,
} from '../search-eval/scoring';
import {
  EVAL_PRODUCTS,
  EVAL_FORMS,
  EVAL_NEGATIVES,
  EVAL_EXTRA,
  EVAL_ABSENT,
  EVAL_HARD,
  catalogueRows,
  evalQueries,
} from '../search-eval/catalogue';

describe('scoring', () => {
  it('hit-rate@k and reciprocal rank (first relevant item)', () => {
    expect(hitAt(['a', 'b'], 'b', 1)).toBe(0);
    expect(hitAt(['a', 'b'], 'b', 2)).toBe(1);
    expect(hitAt([], 'b', 10)).toBe(0);
    expect(reciprocalRank(['a', 'b', 'c'], 'c')).toBeCloseTo(1 / 3);
    expect(reciprocalRank(['c', 'c'], 'c')).toBe(1);
    expect(reciprocalRank([], 'c')).toBe(0);
  });

  it('nDCG@k with binary type relevance', () => {
    // all relevant, as many as exist
    expect(ndcgAt(['t', 't'], 't', 10, 2)).toBeCloseTo(1);
    // one relevant at rank 2 of 1 existing: 1/log2(3)
    expect(ndcgAt(['x', 't'], 't', 10, 1)).toBeCloseTo(1 / Math.log2(3));
    // 2 relevant exist, only 1 retrieved at rank 1: 1 / (1 + 1/log2(3))
    expect(ndcgAt(['t', 'x'], 't', 10, 2)).toBeCloseTo(1 / (1 + 1 / Math.log2(3)));
    // cut at k
    expect(ndcgAt(['x', 'x', 't'], 't', 2, 1)).toBe(0);
    // ideal is capped at k
    expect(ndcgAt(['t'], 't', 1, 20)).toBeCloseTo(1);
    expect(ndcgAt(['t'], 't', 10, 0)).toBe(0);
  });

  it('hybridVariant: keyword-only at or over the strong threshold, else fused head + tail', () => {
    const lex = ['a', 'b', 'c'];
    expect(hybridVariant(lex, ['z'], 3, 50)).toEqual(['a', 'b', 'c']);
    expect(hybridVariant(lex, ['z'], 4, 50)).toEqual(expect.arrayContaining(['a', 'b', 'c', 'z']));
    expect(hybridVariant(lex, ['z'], 4, 50)).toHaveLength(4);
    // null = no threshold: always fused
    expect(hybridVariant(lex, ['z'], null, 50)).toHaveLength(4);
    // no vector ids: exactly the keyword order
    expect(hybridVariant(lex, [], null, 50)).toEqual(lex);
    // head 1: only 'a' is fused with 'b2'; the rest keeps keyword order
    expect(hybridVariant(['a', 'b', 'c'], ['b2'], null, 1).slice(2)).toEqual(['b', 'c']);
  });

  it('summarise: per class means and the core overall', () => {
    const s = (cls: QueryScore['cls'], hit10: 0 | 1, rr: number): QueryScore => ({
      cls,
      core: cls === 'msa' || cls === 'dialect' || cls === 'franco' || cls === 'en',
      key: 'k',
      q: 'q',
      hit10,
      rr,
      ndcg10: rr,
      empty: hit10 === 0,
    });
    const sum = summarise([
      s('msa', 1, 1),
      s('msa', 0, 0),
      s('dialect', 1, 0.5),
      s('franco', 1, 1),
      s('en', 1, 1),
      s('typo', 0, 0),
    ]);
    expect(sum.byClass.msa).toMatchObject({ n: 2, hit10: 0.5, mrr: 0.5, zero: 0.5 });
    expect(sum.byClass.typo).toMatchObject({ n: 1, hit10: 0 });
    // core = the 5 core queries only (typo excluded)
    expect(sum.core.n).toBe(5);
    expect(sum.core.hit10).toBeCloseTo(4 / 5);
    expect(sum.core.mrr).toBeCloseTo(3.5 / 5);
  });
});

describe('pass bar (Ruling SEARCH-10)', () => {
  const summary = (r: Record<'msa' | 'dialect' | 'franco' | 'en', number>, mrr = 0.8): Summary => {
    const byClass = Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, { n: 50, hit10: v, mrr, ndcg10: v, zero: 0 }])
    );
    const all = Object.values(r);
    return {
      byClass,
      core: {
        n: 200,
        hit10: all.reduce((a, b) => a + b, 0) / 4,
        mrr,
        ndcg10: 0,
        zero: 0,
      },
    };
  };
  const lex = summary({ msa: 0.95, dialect: 0.6, franco: 0.5, en: 0.95 });
  const NO_FLOORS = { msa: 0, en: 0 };
  const passBar0 = (l: Summary, h: Summary) => passBar(l, h, NO_FLOORS);

  it('passes at exactly the bar', () => {
    const hy = summary({ msa: 0.93, dialect: 0.8, franco: 0.8, en: 0.93 }, 0.7);
    // overall 0.865 < 0.90: fails only the overall check
    expect(passBar0(lex, hy).failed).toEqual(['hybrid hit-rate@10 overall']);
    const hy2 = summary({ msa: 0.98, dialect: 0.82, franco: 0.82, en: 0.98 }, 0.7);
    const r = passBar0(lex, hy2);
    expect(r.ok).toBe(true);
    expect(r.earnsCost).toBe(true);
  });

  it('fails each rule on its own', () => {
    const good = { msa: 0.98, dialect: 0.9, franco: 0.9, en: 0.98 };
    expect(passBar0(lex, summary({ ...good, dialect: 0.79 })).failed).toContain(
      'dialect hit-rate@10'
    );
    expect(passBar0(lex, summary({ ...good, franco: 0.79 })).failed).toContain(
      'franco hit-rate@10'
    );
    expect(passBar0(lex, summary(good, 0.69)).failed).toEqual(['hybrid MRR overall']);
    // msa regression of 0.03 vs lexical 0.95 (overall stays >= 0.90)
    expect(passBar0(lex, summary({ ...good, msa: 0.92 })).failed).toEqual(['msa no regression']);
    // exactly -0.02 is allowed
    expect(passBar0(lex, summary({ ...good, en: 0.93 })).failed).toEqual([]);
  });

  it('a lift under +0.15 on dialect + franco is "not earning its cost" and fails', () => {
    const lex2 = summary({ msa: 0.95, dialect: 0.8, franco: 0.8, en: 0.95 });
    const hy = summary({ msa: 0.98, dialect: 0.9, franco: 0.9, en: 0.98 });
    const r = passBar0(lex2, hy);
    expect(r.lift).toBeCloseTo(0.1);
    expect(r.earnsCost).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(['dialect+franco lift']);
  });
});

describe('absolute floors (review M5): msa and en never below the names-only hybrid', () => {
  const at = (msa: number, en: number, df = 0.9): Summary => ({
    byClass: Object.fromEntries(
      Object.entries({ msa, dialect: df, franco: df, en }).map(([k, v]) => [
        k,
        { n: 50, hit10: v, mrr: 0.9, ndcg10: v, zero: 0 },
      ])
    ),
    core: { n: 200, hit10: (msa + en + 2 * df) / 4, mrr: 0.9, ndcg10: 0, zero: 0 },
  });
  const lex = at(0.5, 0.8, 0.5);
  const floors = { msa: 0.98, en: 1.0 };

  it('one query (0.02) below the floor is allowed, two is not', () => {
    expect(passBar(lex, at(0.96, 0.98), floors).failed).toEqual([]);
    expect(passBar(lex, at(0.94, 1.0), floors).failed).toEqual(['msa floor']);
    expect(passBar(lex, at(1.0, 0.96), floors).failed).toEqual(['en floor']);
  });

  it('reports the margin of each check in queries', () => {
    const r = passBar(lex, at(0.96, 1.0), floors);
    const m = Object.fromEntries(r.checks.map(c => [c.name, c.marginQueries]));
    expect(m['msa floor']).toBe(0); // exactly on the floor
    expect(m['en floor']).toBe(1); // one query above it
    expect(m['franco hit-rate@10']).toBe(5); // 0.90 vs 0.80 over 50 queries
  });
});

describe('catalogue', () => {
  it('200 core queries over 50 unique types, none blank', () => {
    expect(EVAL_PRODUCTS.length * EVAL_FORMS.length).toBe(200);
    expect(new Set(EVAL_PRODUCTS.map(p => p.key)).size).toBe(50);
    const qs = evalQueries();
    expect(qs.filter(q => q.core)).toHaveLength(200);
    expect(qs.every(q => q.q.trim().length > 0)).toBe(true);
  });

  it('product ids are unique, every extra query and negative points at a real type', () => {
    const rows = catalogueRows();
    expect(new Set(rows.map(r => r.id)).size).toBe(rows.length);
    const keys = new Set(EVAL_PRODUCTS.map(p => p.key));
    expect(EVAL_EXTRA.every(e => keys.has(e.key))).toBe(true);
    expect(EVAL_NEGATIVES.every(n => keys.has(n.near) && !keys.has(n.key))).toBe(true);
  });

  it('absent-product queries exist and name nothing the store sells', () => {
    expect(EVAL_ABSENT.length).toBeGreaterThanOrEqual(10);
    const names = new Set(catalogueRows().flatMap(r => [r.nameAr, r.name]));
    expect(EVAL_ABSENT.some(q => names.has(q))).toBe(false);
  });

  it('hard set (review M2): 20 per form, no query word inside any product name of its type', () => {
    for (const f of ['msa', 'dialect', 'franco', 'en'])
      expect(
        EVAL_HARD.filter(h => h.form === f),
        f
      ).toHaveLength(20);
    const rows = catalogueRows();
    const keys = new Set(EVAL_PRODUCTS.map(p => p.key));
    const leaks: string[] = [];
    for (const h of EVAL_HARD) {
      expect(keys.has(h.key), h.q).toBe(true);
      const names = rows
        .filter(r => r.type === h.key)
        .map(r => normalizeArabicSearch(`${r.nameAr} ${r.name}`));
      for (const t of normalizeArabicSearch(h.q).split(' '))
        if (t.length >= 3 && names.some(n => n.includes(t))) leaks.push(`${h.q} → ${t}`);
    }
    expect(leaks).toEqual([]);
  });

  it('a dense type exists, so the keyword-strong threshold is exercised', () => {
    const rows = catalogueRows();
    const max = Math.max(...EVAL_PRODUCTS.map(p => rows.filter(r => r.type === p.key).length));
    expect(max).toBeGreaterThanOrEqual(20);
  });
});
