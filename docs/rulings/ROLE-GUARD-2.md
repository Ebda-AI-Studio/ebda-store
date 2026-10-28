# ROLE-GUARD-2

> Section: 2026-10-07 — cache generation counters + fail-closed Node DB role guard (branch `fix/cache-gen-and-role-guard`)

Ruling ROLE-GUARD-2 — KEPT: the inherited `ALLOW_BYPASSRLS_ROLE=true` hatch stays on the Node shell (it now also covers a superuser and logs at `error` level on every boot) so the twin keeps one contract with Ebda Store, whose production depends on it. Ebda's runtime role is `ebda_app`, so the variable should stay unset; it never excuses an unverifiable role, and the Workers shell ignores it. Cost if wrong: a Node deployment that copies Ebda Store's env verbatim would serve with RLS off, visible only as the boot `error` line.
