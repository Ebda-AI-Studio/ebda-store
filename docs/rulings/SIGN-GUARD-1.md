# SIGN-GUARD-1

> Section: 2026-11-11 — signed-number guard (branch `fix/signed-number-rtl`, PR #699)

**Ruling SIGN-GUARD-1 — `tests/unit/signed-number-guard.test.ts` is a lint aid for hand-built number signs, not a proof; independent review and the render tests (`signed-number-format.test.tsx`) are the real gate.**
The guard parses every `.ts`/`.tsx` under `apps/{admin,web,orders}` + `packages/ui` with the TypeScript AST and fails on: a sign literal, the `MINUS`/`PLUS` constants or a sign entity (`&minus;`, `&#8722;`, `&#x2212;`, `&plus;`) next to a value (S1-S6); a `${'-'}` template span; `<MinusGlyph/>` before any value and `<PlusGlyph/>` before a number-shaped value (S7, the glyphs are `aria-hidden`); a hyphen glued to a label word (`EGP-`, `total-`) or in front of a number-shaped value. Hyphenated ids (`tier2-`, `variant-price-`) are not signs. There is no exemption marker; a non-number glyph uses `PlusGlyph`, `MinusGlyph`, `Sep` or a named constant. Every shape above has a bad fixture.

Accepted residual (NOT detected): sign built through `join()`/`concat()` (`['-', n].join('')`); fullwidth/small signs outside `＋ － ﹢ ﹣`; a sign read from a variable the guard cannot resolve; a number-shaped value whose name matches none of the `NUMBERISH` words.
Cost if wrong: a rare hand-built sign slips through the guard and is caught only by review or the visual check, and a `-0` / "N-" glitch can reach one screen in Arabic until then.
