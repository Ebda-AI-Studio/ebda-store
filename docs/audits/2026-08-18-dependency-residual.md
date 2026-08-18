# Dependency advisory residual — 2026-08-18

`npm audit --package-lock-only`

| scope                         | result                                                   |
| ----------------------------- | -------------------------------------------------------- |
| **production** (`--omit=dev`) | **0 vulnerabilities** — the zero-tolerance gate is clean |
| dev (tooling)                 | 6 high, all one unfixable cluster (below)                |

## Fixed in this pass

`deepmerge-ts` 7.1.5 → 8.0.1 — **CVE-2026-40345**, stack exhaustion when merging
recursive object graphs (GitHub-reviewed HIGH). Reaches us transitively through
`@prisma/config`; the whole reported `prisma` / `@prisma/config` / `deepmerge-ts`
cluster is that single leaf.

npm's suggested remedy is `prisma@6.12.0` — a **major downgrade** from the `^6.19.3`
this repo declares. No published prisma resolves it either: `@prisma/config@latest`
still pins `deepmerge-ts@7.1.5`. So the leaf is pinned via `overrides`, per the
dependency-discipline rule, rather than moving prisma backwards.

## Accepted residual — `@lhci/cli` dev cluster (6 high)

```
@lhci/cli → lighthouse → puppeteer-core → @puppeteer/browsers → extract-zip
```

Root advisory: **`extract-zip` — unvalidated symlink path traversal**.

Why it is not fixed, checked rather than assumed on 2026-08-18:

- `extract-zip` advisory range is `*` — **every published version is vulnerable**,
  including the current 2.0.1. There is no fixed version to move to.
- `@lhci/cli` is already at the latest published release (0.15.1). npm's
  `fixAvailable` of `@lhci/cli@0.12.0` is a **downgrade to an older major that merely
  predates the advisory data**, not a fix.
- Every entry in the cluster (`@lhci/utils`, `lighthouse`, `puppeteer-core`,
  `@puppeteer/browsers`) is flagged solely for depending on that one leaf.

Exposure in our usage:

- **Dev/CI only.** `@lhci/cli` is a `devDependency` of `apps/web` and is invoked
  exclusively by `.github/workflows/lighthouse-nightly.yml`, which additionally does
  its own `npm install -D @lhci/cli`. It is never bundled into any deployed artifact
  and does not appear in the production dependency graph — hence
  `--omit=dev` is clean.
- The zip `extract-zip` unpacks is the **Chrome build that `@puppeteer/browsers`
  downloads from Google's CDN over HTTPS**. It is not attacker-supplied and not
  reachable from any request path, tenant input, or merchant upload.

This matches the CI audit split (rule 15): production is zero-tolerance, dev tooling
is gated at high for exactly this case — an unfixable transitive advisory in a
build-time tool.

**Re-check trigger:** revisit when `extract-zip` publishes a fixed release, or when
`@lhci/cli` ships a major that drops the `puppeteer-core` chain. Not before — there is
no action available in between.

## Not removed

`@lhci/cli` is genuinely in use (`.github/workflows/lighthouse-nightly.yml` +
`apps/web/lighthouserc.json`, which audits five wadyaljuz.com URLs nightly). Dropping
the dependency would clear all six advisories but would delete a live performance gate,
so it stays.
