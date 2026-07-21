# AI Features Universal Baseline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make every AI feature available on every paid plan, so the AI-first product positioning is true in the product and not just the pitch.

**Architecture:** FWB resolves features as `StoreFeature` override → else `PLAN_BASELINE[plan]`. Three AI feature keys move into `STARTER_CORE` (which layers into professional and enterprise), and one AI job that was gated behind an ERP module is re-pointed at the correct gate. No new models, no migration, no runtime code paths added.

**Tech Stack:** TypeScript, Prisma, Vitest, Express, Next.js.

## Global Constraints

- **`free` is NOT a paid plan.** It is documented in `plan-baselines.ts` as the stripped demo / lapsed-payment grace state. Ahmad's directive is "all plans are paid" — `free` is excluded deliberately. Its `≤5 features` test guard stays intact.
- **Strict-superset invariant** (`professional ⊇ starter`, `enterprise ⊇ professional`) is unit-tested and must keep passing. Moving a key _into_ `STARTER_CORE` preserves it; the key must be **removed** from the higher additions array to avoid duplicates.
- **Plan changes never touch `StoreFeature` rows** — super-admin overrides win and are preserved across upgrades/downgrades (Ahmad's 2026-05-27 decision).
- **Documentation parity:** `docs/business/plan-feature-matrix.md` ships in the same change.
- **Branch hygiene:** work in a worktree, never commit on the root `main` checkout. `git add` explicit paths only.
- **CI is currently red on `main`** (`Security Audit` required check). PR #843 fixes it. This PR will show the same failure until #843 merges — that is inherited, not caused here.

---

## Verified starting state

Gating map, confirmed by reading source (not inferred):

| AI surface                                                                                                           | Gate                        | Baseline today         | Action                                 |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------- | -------------------------------------- |
| AI Tools hub — 20 endpoints in `ai.routes.ts` (translate, SEO, categorize, FAQ, AEO, GEO, llms.txt, image-alt, tags) | `bulk_operations`           | STARTER_CORE           | none — already universal               |
| Dead-stock detection                                                                                                 | `inventory.basic`           | STARTER_CORE           | none — already universal               |
| Insights (RFM, cohorts, funnel)                                                                                      | _ungated_                   | n/a                    | none                                   |
| AI recommendations / upsell / cross-sell / FBT                                                                       | `upsell_crosssell`          | PROFESSIONAL_ADDITIONS | **move to STARTER_CORE**               |
| Profit-anomaly AI scan                                                                                               | `accounting.profit_anomaly` | ENTERPRISE_ADDITIONS   | **move to STARTER_CORE**               |
| AI Product Feed                                                                                                      | `agent_feed`                | **no baseline at all** | **add to STARTER_CORE**                |
| Reorder suggestions (AI)                                                                                             | `inventory.purchase_orders` | ENTERPRISE_ADDITIONS   | **re-point gate to `inventory.basic`** |

**Dependency check (verified, not assumed):** `profit-anomaly.service.ts` reads only `prisma.coupon`, `prisma.inventoryHistory`, `prisma.payment`, `prisma.profitAnomaly`, `prisma.store` — **no journal/accounting data**. It therefore does not require `accounting.basic` and can move to starter independently.

**Why the reorder gate is a bug, not a preference:** dead-stock scan gates on `inventory.basic`; reorder scan gates on `inventory.purchase_orders`. Both are AI suggestion engines. Gating an AI feature behind an ERP module means freeing the AI would hand over the entire purchase-orders module. Re-pointing the gate frees the AI without giving away the module.

## File structure

- `packages/shared/src/plan-baselines.ts` — the three baseline moves. Single source of truth.
- `packages/shared/src/__tests__/plan-baselines.test.ts` — encodes the _old_ policy at line 68; must be rewritten to encode the new one.
- `apps/api/src/lib/inngest/functions/stock-reorder-scan.ts` — two `isFeatureEnabled` call sites.
- `apps/web/src/app/llms.txt/route.ts` — stale comment claiming agent_feed is in no baseline.
- `docs/business/plan-feature-matrix.md` — documentation parity.

---

### Task 1: Move the three AI keys into the paid baseline

**Files:**

- Modify: `packages/shared/src/plan-baselines.ts`
- Test: `packages/shared/src/__tests__/plan-baselines.test.ts`

**Interfaces:**

- Consumes: `FeatureKey` from `./features`, `StorePlan` from `./types`.
- Produces: `PLAN_BASELINE` with `agent_feed`, `upsell_crosssell`, `accounting.profit_anomaly` present in `starter`, `professional`, `enterprise` and absent from `free`.

- [ ] **Step 1: Rewrite the failing assertions to encode the new policy**

In `packages/shared/src/__tests__/plan-baselines.test.ts`, replace the test at line 68:

```typescript
it('professional does NOT include multi-warehouse (enterprise-only)', () => {
  expect(PLAN_BASELINE.professional).not.toContain('inventory.multi_warehouse');
});

// AI-first policy (2026-07-21): every AI feature is available on every paid
// plan. AI is the product's core differentiator — gating it behind tiers made
// the positioning untrue. `free` is excluded: it is the lapsed-payment grace
// state, not a plan anyone buys.
it('every paid plan includes every AI feature', () => {
  const AI_FEATURES = [
    'agent_feed',
    'upsell_crosssell',
    'accounting.profit_anomaly',
    'bulk_operations',
    'inventory.basic',
  ] as const;

  for (const plan of ['starter', 'professional', 'enterprise'] as const) {
    for (const key of AI_FEATURES) {
      expect(PLAN_BASELINE[plan]).toContain(key);
    }
  }
});

it('free does not get AI features (lapsed-payment grace state)', () => {
  expect(PLAN_BASELINE.free).not.toContain('agent_feed');
  expect(PLAN_BASELINE.free).not.toContain('accounting.profit_anomaly');
});

it('no baseline array contains duplicate keys', () => {
  for (const plan of STORE_PLANS) {
    const arr = PLAN_BASELINE[plan];
    expect(new Set(arr).size).toBe(arr.length);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/shared/src/__tests__/plan-baselines.test.ts`
Expected: FAIL — `every paid plan includes every AI feature` fails because `starter` contains none of `agent_feed`, `upsell_crosssell`, `accounting.profit_anomaly`.

- [ ] **Step 3: Move the keys**

In `packages/shared/src/plan-baselines.ts`, append to `STARTER_CORE` (before the closing `]`):

```typescript
  // AI-first policy (2026-07-21, Ahmad): every AI capability is available on
  // every paid plan. AI is the core differentiator — tiering it made the
  // "AI-first product" positioning untrue and left the flagship AI Product
  // Feed disabled on every store. Revenue comes from the platform, not from
  // gating the differentiator. Restrict a specific client via a StoreFeature
  // override, as with `whatsapp` and `staff_accounts`.
  'agent_feed',
  'upsell_crosssell',
  'accounting.profit_anomaly',
```

Delete `'upsell_crosssell',` from `PROFESSIONAL_ADDITIONS`.

Delete `'accounting.profit_anomaly',` from `ENTERPRISE_ADDITIONS`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/shared/src/__tests__/plan-baselines.test.ts`
Expected: PASS, including the pre-existing superset and `free ≤ 5` guards.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/plan-baselines.ts packages/shared/src/__tests__/plan-baselines.test.ts
git commit -m "feat(plans): make every AI feature universal on all paid plans"
```

---

### Task 2: Re-point the reorder-scan gate off the ERP module

**Files:**

- Modify: `apps/api/src/lib/inngest/functions/stock-reorder-scan.ts` (two `isFeatureEnabled` call sites)

**Interfaces:**

- Consumes: `featureService.isFeatureEnabled(storeId, key)`.
- Produces: reorder suggestions gated on `inventory.basic`, matching `stock-deadstock-scan.ts`.

- [ ] **Step 1: Read both call sites**

Run: `grep -n "isFeatureEnabled" apps/api/src/lib/inngest/functions/stock-reorder-scan.ts`
Expected: two hits, both referencing `'inventory.purchase_orders'`.

- [ ] **Step 2: Change both to `inventory.basic`**

Replace `'inventory.purchase_orders'` with `'inventory.basic'` at both sites, and add above the first:

```typescript
// Gate on inventory.basic, not inventory.purchase_orders (2026-07-21):
// reorder suggestions are an AI feature and must follow the AI-first
// policy, but inventory.purchase_orders gates the whole ERP purchase-
// order module. Matches stock-deadstock-scan.ts, the sibling AI scan.
```

- [ ] **Step 3: Verify no other consumer assumed the old gate**

Run: `grep -rn "inventory.purchase_orders" apps packages docs`
Expected: remaining hits are the purchase-orders module itself and the feature registry — **not** the reorder scan.

- [ ] **Step 4: Run the reorder tests**

Run: `npx vitest run --reporter=dot -t reorder`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/inngest/functions/stock-reorder-scan.ts
git commit -m "fix(stock): gate AI reorder scan on inventory.basic, not the PO module"
```

---

### Task 3: Correct the stale llms.txt comment

**Files:**

- Modify: `apps/web/src/app/llms.txt/route.ts:273`

**Interfaces:**

- Consumes: `store.enabledFeatures`.
- Produces: unchanged runtime behaviour; the conditional now resolves true for every paid store, so every storefront advertises its feed to AI crawlers.

- [ ] **Step 1: Replace the stale comment**

The comment currently reads `agent_feed is an individually-priced add-on (not in any plan baseline)`. That is now false. Replace with:

```typescript
// agent_feed is in every paid plan baseline (AI-first policy, 2026-07-21).
// Still conditional: a super-admin StoreFeature override can disable it for
// a specific client, and the `free` grace plan does not include it.
```

- [ ] **Step 2: Verify the conditional itself is unchanged**

Run: `grep -n "enabledFeatures?.includes('agent_feed')" apps/web/src/app/llms.txt/route.ts`
Expected: one hit, logic untouched — only the comment changed.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/llms.txt/route.ts
git commit -m "docs(web): correct stale agent_feed baseline comment in llms.txt"
```

---

### Task 4: Documentation parity

**Files:**

- Modify: `docs/business/plan-feature-matrix.md`

- [ ] **Step 1: Update the agent_feed entry**

Replace the `**AI Product Feed** (`agent_feed`) — individually-priced add-on, in no plan baseline …` paragraph with:

```markdown
- **AI Product Feed** (`agent_feed`) — **in every paid plan baseline** (Starter/Professional/Enterprise) as of 2026-07-21 under the AI-first policy. `free` (lapsed-payment grace) excludes it. Still fail-closed at the API: a store without the feature gets a **404** (not 403) on `GET /api/v1/public/feed/products.json` and the storefront's `/feeds/products.json`, so a disabled store never reveals the endpoint's existence. Disable for a specific client via a `StoreFeature` override.
```

- [ ] **Step 2: Record the tier moves**

Add under the plan-baseline change log:

```markdown
### 2026-07-21 — AI-first baseline

`agent_feed`, `upsell_crosssell` and `accounting.profit_anomaly` moved into `STARTER_CORE`; every AI capability is now available on every paid plan. Reorder-suggestion scan re-gated from `inventory.purchase_orders` to `inventory.basic` so an AI feature is no longer gated behind an ERP module. Rationale: FWB is an AI-first product and AI is the sole uncontested differentiator vs OSOSS — tiering it made the positioning untrue and left the flagship feed disabled on every store.
```

- [ ] **Step 3: Commit**

```bash
git add docs/business/plan-feature-matrix.md
git commit -m "docs(business): record AI-first plan baseline change"
```

---

### Task 5: Full verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 2: Unit suite**

Run: `npx vitest run --reporter=dot`
Expected: PASS. Any failure naming `profit_anomaly`, `upsell`, `agent_feed` or `purchase_orders` is a real consumer of the old policy — fix it, don't skip it.

- [ ] **Step 3: Blast-radius sweep and state the result**

Run:

```bash
grep -rn "agent_feed\|upsell_crosssell\|accounting.profit_anomaly\|inventory.purchase_orders" \
  apps packages docs .github 2>/dev/null | grep -v node_modules
```

Confirm every hit is either (a) the feature registry, (b) an intentional consumer whose behaviour is now correct, or (c) updated docs. **State the sweep result in the PR body** — no stated result means the change is not done.

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "feat(plans): make every AI feature universal on all paid plans" --body "<see plan>"
```

Note in the body that `Security Audit` will fail until #843 merges, and that the failure is inherited from `main`.
