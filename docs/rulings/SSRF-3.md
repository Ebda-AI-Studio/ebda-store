# SSRF-3

> Section: 2026-09-11

**Ruling SSRF-3 — the carrier registry gate was weaker than SSRF-1 claimed.**

SSRF-1 declined the ESLint widening in favour of a registry gate in
`tests/unit/carrier-ssrf.test.ts`. The scoped audit then showed that gate had
three evasions **inside the directory it covers**, which SSRF-1's "cost if
wrong" paragraph understated as "a future service outside
`services/carriers/**`":

2. **The gate was weaker than claimed.** Keying on the literal name `baseUrl`
   and on import presence left three evasions inside the very directory it
   covers: a field named `apiUrl`/`endpoint`/`host`, a credentials interface
   declared in the sibling `types.ts`, and an import used on three of four
   fetch paths. It now strips comments (its first run failed on iCarry's own
   docstring — the defect already filed as #1678 against another gate), scans
   every `.ts` in the directory, matches any URL-shaped field name, and asserts
   **zero bare `fetch(`** rather than import presence. `aramex.carrier.ts`
   adopted the helper rather than being excepted.

Cost if wrong: the gate is still a text scan. A carrier that builds its URL in
a helper the regex cannot follow, or one added outside
`services/carriers/**`, passes it — and SSRF-1 declined the ESLint rule that
would have been the second, independent net.
