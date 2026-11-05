# Ebda Store / Ebda AI Studio naming implementation plan

> For agentic workers: use superpowers:executing-plans to implement this plan in the current session. Ahmad approved scope: folders, repositories and app branding. Do not spawn agents.

**Goal:** Name the commerce product Ebda Store and the company/business Ebda AI Studio across current code, GitHub and local organization, preserving working deployments.

**Architecture:** Retain the existing central `BRAND.product` and `BRAND.company` objects. Classify consumers as product or company instead of replacing every occurrence of `Ebda`. Apply the local folder move only after updating repository and workspace references, and repair registered worktrees.

**Tech stack:** Existing TypeScript/React monorepo, Git/GitHub CLI, Cloudflare Workers, foundation shell scripts. No new dependencies or database migrations.

**Spec:** Ahmad’s 2026-10-10 instruction: the existing Ebda project must be named Ebda Store; business-level material must be named Ebda AI Studio. Scope confirmed: folders, repos and app branding.

## Global constraints

- Product English: `Ebda Store`; Arabic: existing approved `ابدأ ستور`.
- Company English: `Ebda AI Studio`; Arabic: existing approved `ابدأ ستوديو للذكاء الاصطناعي`.
- Existing expanded legal company names remain where a legal operator name is required.
- Repository ownership remains Whisky-11; this task does not create or transfer an organization.
- Domains, user records, store records, payment identifiers, RLS roles, Worker names, secret names and durable resource bindings remain operational identifiers. Renaming a product does not require migrating them.
- Root checkout stays on main. Work occurs on `chore/ebda-store-naming` in the isolated worktree.
- Preserve unrelated root screenshots, every registered worktree and uncommitted changes.
- Business documents remain local, outside git. Never copy their contents into a public repository.

## Observed baseline

- Canonical code: `Ebda-AI-Studio/internal-projects/ebda`; private repository `Whisky-11/ebda`, main branch.
- Business documents: `Ebda-AI-Studio/business/ebda`.
- `BRAND.product` already carries Ebda Store; `BRAND.company.shortNameEn` already carries Ebda AI Studio.
- `BRAND.name` and `BRAND.nameAr` still contain the ambiguous master name and reach marketing, orders, storefront, API documentation, exports, help and status surfaces.
- Root checkout contains two unrelated untracked screenshots. Registered worktrees include three nested `.claude/worktrees` paths and many external worktrees.
- Live marketing and merchant hosts both return 200 from Cloudflare. HTTP success alone is not branding verification.
- Foundation `ops/agent-dispatch.sh` still resolves `ebda` to the current old folder; `ops/tests/projects-layout.test.sh` also names that folder.
- The Codex project inventory still has an obsolete pre-move path. Refresh its saved project association after the filesystem move; do not rename by modifying opaque app state files.

## Review focus

1. Product screens must not inherit the company name simply because they consume the generic brand helper.
2. A repo rename must not break deploy checkout, badges, issue links, local remotes or scheduled scripts.
3. Moving the root must preserve nested worktree gitdir links and unrelated dirty files.
4. Company copy must not become product copy on legal/operator surfaces; historical documents must stay historically accurate.
5. Both locales and installable manifests must carry the intended identity, including visible wordmarks, not only image alt text.

## Task 1 — Explicit app identities

**Files:** `packages/shared/src/brand/index.ts`; consumers in `apps/admin`, `apps/orders`, `apps/web`, `apps/api`, `apps/marketing`, `apps/help`, `apps/docs`, `apps/status`, `packages/site-kit`; `tests/unit/brand.test.ts`, `tests/unit/ebda-admin-brand.test.ts`.

**Interfaces:** Preserve `BRAND.product` and `BRAND.company` public keys. Define generic `BRAND.name` / `nameAr` as the company short names. Add `productName(locale?: string | null)` for product wordmarks and metadata. `brandName` returns the company identity. Product footer helper `poweredByBrand` names the product.

- [ ] Read every consumer from the combined search and classify it before editing:

```bash
rg -n 'BRAND\.(name|nameAr|product|company)|brandName\(|poweredByBrand\(|Ebda|ابدأ' apps packages tests/unit/brand.test.ts tests/unit/ebda-admin-brand.test.ts
```

- [ ] Pin the contract in the existing meaningful brand tests:

```ts
expect(BRAND.name).toBe('Ebda AI Studio');
expect(BRAND.product.nameEn).toBe('Ebda Store');
expect(BRAND.company.shortNameEn).toBe('Ebda AI Studio');
expect(productName('en')).toBe('Ebda Store');
expect(productName('ar')).toBe('ابدأ ستور');
expect(brandFrom()).toBe(`Ebda Store <${BRAND.noReplyEmail}>`);
```

- [ ] Run the existing brand suites before the implementation to observe the new assertions fail.
- [ ] Implement the helper with the existing locale convention:

```ts
export function productName(locale?: string | null): string {
  return locale?.toLowerCase().startsWith('ar') ? BRAND.product.nameAr : BRAND.product.nameEn;
}
```

- [ ] Update merchant/admin, orders, storefront platform identity, product API documentation, exports and product help/docs to consume product fields. Company marketing navigation, operator/legal/contact blocks and business-level status identity consume company fields. Marketing copy describing the commerce product still names Ebda Store.
- [ ] Add adjacent visible text for SVG wordmark consumers where the asset itself only reads Ebda; update layout sizing so the full name is readable in both locales at mobile width.
- [ ] Check manifests and login/reset/registration/builder screens. Preserve MFA issuer compatibility for existing enrollments; document any issuer display choice before changing it.
- [ ] Run brand suites, app typechecks and changed-app builds. Visually exercise company marketing and merchant login in both locales, including 390px viewport and manifests. Commit specific paths only.

## Task 2 — Repository identity and current documentation

**Files:** root `package.json`, root `package-lock.json`, `README.md`, `CLAUDE.md`, current deployment docs, current workflow references. Keep generated graph output out of broad search output; regenerate it after code changes.

**Interfaces:** Repository name becomes `Whisky-11/ebda-store`; npm root package becomes `ebda-store`; package scopes remain `@ebda/*` internal identifiers. Expanded legal operator remains unchanged.

- [ ] Confirm the destination repo slug does not already exist, and enumerate every old remote reference:

```bash
gh repo view Whisky-11/ebda-store --json name,url
rg -n -i 'github\.com/whisky-11/ebda([/ .#)]|$)|Whisky-11/ebda([/ .#)]|$)' --glob '!package-lock.json' --glob '!graphify-out/**' .
```

- [ ] Update current links and package root metadata; regenerate root lock metadata with existing npm tooling. Retain historical references inside dated decision records when they describe an old event, with a current-name note in their index.
- [ ] Company wording for author/operator is Ebda AI Studio; project and service wording is Ebda Store.
- [ ] Run formatting, brand tests and repository metadata checks before changing the remote name.
- [ ] Rename through GitHub with an explicit API body:

```bash
gh api --method PATCH repos/Whisky-11/ebda -f name=ebda-store -f description='Ebda Store by Ebda AI Studio — self-serve store builder for Egypt'
git remote set-url origin https://github.com/Whisky-11/ebda-store.git
```

- [ ] Confirm private visibility, default branch, repository URL and branch refs independently through GitHub; check GitHub Actions integrations and any external source repository bindings. Update bindings that require the canonical new slug rather than trusting redirect support. Push a reviewed branch and attach its PR to this chat.

## Task 3 — Folder move and workspace references

**Files:** local project folders; `~/Desktop/projects/README.md`; foundation `ops/agent-dispatch.sh`, `ops/tests/projects-layout.test.sh`; current local automation/launchd references found by the sweep. Foundation edits occur in a separate task worktree and PR, not its main checkout.

**Interfaces:** Canonical product root `Ebda-AI-Studio/internal-projects/ebda-store`; business document root `Ebda-AI-Studio/business/ebda-ai-studio`. Existing task worktree directory names remain stable. Dispatch accepts canonical `ebda-store` and a documented compatibility alias `ebda` to avoid breaking queued tasks.

- [ ] Export `git worktree list --porcelain` and statuses before moving. Confirm both destination paths are absent and business folder is a plain folder. Save an operational move manifest outside git.
- [ ] Change foundation resolver and layout fixtures to the new root. Run:

```bash
bash ops/tests/projects-layout.test.sh
bash ops/projects-layout-check.sh
```

- [ ] Commit/push foundation changes and install through its supported installer after review, preserving the generated-copy boundary.
- [ ] Move only the two approved folders:

```bash
mv ~/Desktop/projects/Ebda-AI-Studio/internal-projects/ebda ~/Desktop/projects/Ebda-AI-Studio/internal-projects/ebda-store
mv ~/Desktop/projects/Ebda-AI-Studio/business/ebda ~/Desktop/projects/Ebda-AI-Studio/business/ebda-ai-studio
```

- [ ] Run `git worktree repair` from the new root with every registered path, translating nested paths to their new parent. Verify `git status`, branch and git-common-dir for each registration. Confirm the two unrelated screenshots survive.
- [ ] Update workspace README and current local path consumers. Create the supported new-path memory association so existing history survives. Do not rename arbitrary archived worktrees or historical logs.
- [ ] Refresh Codex saved project associations through supported UI/API. Verify the saved project points at the new root rather than the old pre-move business path.
- [ ] Verify resolver canonical name and alias resolve to the new root, layout tests pass and no active operational old-root consumers remain.

## Task 4 — Ship and verify the naming

**Files:** tracked `handoff.md` (Goal / Current state / Done / In progress / Left to do); naming ruling in current decision ledger; workspace output verification report.

- [ ] Record Ruling NAMING-1 at implementation: product Ebda Store, company Ebda AI Studio; domains and durable infrastructure identifiers are preserved because they are service addresses, not ambiguous display branding. Cost if wrong: customers may see a legacy service identifier in technical diagnostics.
- [ ] Sweep product/company fields, repository slug and both moved roots across code, configs, workflows, active local scheduled jobs, docs, sibling repositories and app manifests. Fix active consumers; list any historical matches explicitly.
- [ ] Run appropriate existing CI gates; broad test expansion is unnecessary for text-only paths after the meaningful brand checks and builds pass.
- [ ] Deploy affected apps through existing guarded deployment workflows after the reviewed change lands. Confirm production revision against the landed commit and open changed screens in Arabic/English. Check real rendered names and install manifests, not just HTTP status.
- [ ] Verify public store browsing and merchant login entry still load; do not create real orders or send customer notifications for a naming check.
- [ ] Report verified folder/repo/app names and any remaining blocker honestly. Update handoff and memory after each commit and at session end.

## Execution evidence

- 2026-10-10: scope and native execution approved by Ahmad.
- Brand tests observed fail before code changes; affected suite now 81 passing.
- All app typechecks passed. Marketing/admin/web/orders/docs/help/status builds passed.
- Independent whole-branch review found 5 naming defects; fixed with failing-then-passing visible-name and translation tests.
- GitHub repository renamed to Whisky-11/ebda-store; private visibility and main branch confirmed independently.
- Folder alias tests: 18 passed. Folder move and production deployment are in progress.
