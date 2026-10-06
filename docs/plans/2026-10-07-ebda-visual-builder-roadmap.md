# Ebda visual page builder — roadmap and specification

Date: 2026-10-07. Status: proposed product direction, added at Ahmad's request; implementation is not started by this document.

## Goal and finish line

An Egyptian merchant can compose an ecommerce homepage from Ebda sections, see the actual storefront rendering, edit safely in Arabic or English, and publish without developer help. Prove it by creating a page, changing section order and properties, previewing three viewport sizes, undoing changes, saving a draft, publishing, and placing a sandbox order from the resulting storefront.

Existing stores, theme values, layouts, checkout, inventory, prices, permissions, and PostgreSQL tenant isolation must retain their behavior. Completion requires evidence from the editor, API, storefront and Cloudflare runtime; a build alone is insufficient.

## Existing foundation and scope

Observed source at main merge commit `65c815ce`:

- `apps/admin/src/app/stores/[id]/page-builder/page.tsx` already uses dnd-kit sortable sections, layout settings, typography overrides, color controls and section previews.
- `packages/shared/src/types/store-layout.ts` defines the existing layout contract.
- `apps/api/src/routes/store-layout.routes.ts` and `public-store-layout.routes.ts` are integration surfaces to inspect before changing persistence or publication.
- `apps/web/src/templates/shared/section-spacing.ts`, `section-typography.ts` and `section-bg.ts` contain shared storefront presentation helpers.

These are source observations, not a claim that every existing flow works in production. Phase 0 must establish which proposed capabilities already work and what remains missing. Keep the older smart-colors/page-builder specification as historical context: [existing design](../superpowers/specs/2026-05-18-smart-colors-and-page-builder-design.md).

## Product specification

The desktop editor has a section tree, storefront canvas and properties panel. Selecting a section in either tree or canvas selects the same stable section ID. The properties panel exposes only that section's supported controls. Desktop, tablet and mobile previews use the same renderer and data contract as the storefront. Small editor screens use panels/drawers rather than squeezing three columns together.

Merchants can add, reorder, duplicate, hide and remove permitted sections. Dragging has keyboard and button alternatives. Header/footer cardinality and placement are explicit registry rules; nested slots are limited to declared section capabilities. Do not expose arbitrary HTML, JavaScript, React source or an unrestricted DOM tree.

Initial block catalogue: announcement bar, header/navigation, hero, collection/product grid, image with text, testimonials, newsletter and footer. Map these to existing equivalents first. Product cards render real commerce data; merchants can select collections, supported column counts, card presentation, price visibility and add-to-cart visibility, but cannot override authoritative price, stock or checkout rules.

Later candidates: WhatsApp support/order buttons, product questions, tracking, recommendations, recently viewed and flash-sale presentation. Each requires its own working backend/provider contract before being advertised as available. A newsletter block needs a real consent and subscription flow; tracking must not reveal another customer's order.

## Architecture and page contract

`Editor → validated Page Definition JSON → Ebda renderer → storefront`, with catalogue and commerce data resolved through existing tenant-scoped APIs.

The component registry owns type IDs, bilingual labels, allowed props, validation, defaults, renderer references, slot rules and responsive capabilities. Shared schema validation is authoritative at API edges. Renderer components remain Ebda-owned React components. Editor code must stay out of the storefront bundle.

Illustrative future format, not an existing accepted API payload:

```json
{
  "schemaVersion": 1,
  "sections": [
    {
      "id": "hero-1",
      "type": "hero",
      "props": { "title": "New collection", "buttonLabel": "Shop now" }
    },
    {
      "id": "products-1",
      "type": "product-grid",
      "props": { "collectionId": "collection-id", "columns": 4 }
    }
  ]
}
```

Before adopting this shape, reconcile it with existing layout JSON; prefer additive conversion and compatibility rendering over replacing stored documents blindly. Declare schema versioning, document limits, stable IDs, unknown-type handling and migration tests. Validate asset/link schemes and collection ownership. Reject invalid writes with actionable errors; preserve the last valid document.

Draft and published revisions are distinct. Saving a draft does not change the public store. Publishing atomically selects a validated revision and invalidates every affected layout cache. Use revision checks to detect concurrent edits; a stale tab must not silently overwrite newer work. Undo/redo is bounded editor history, separate from persisted revisions. One layer owns each save/publish write.

## Roadmap and acceptance checks

| Phase                          | Deliverable                                                                                                              | Evidence required to complete                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Baseline                   | Inventory existing blocks, schema, renderers, save paths, caches and missing flows; demonstrate current editor           | Two stores retain their current rendering; save/reload round trip; tenant isolation tests; documented gap matrix                                                |
| 1 — Registry and compatibility | Shared section registry, validated/versioned document, existing-layout adapter and shared renderer                       | Existing fixtures render equivalently; malformed/cross-store references rejected; old documents survive round trips                                             |
| 2 — Visual editor              | Canvas/tree selection, typed properties, constrained slots, reorder/duplicate/hide/remove, responsive preview, undo/redo | Drive every action in Arabic/RTL and English; keyboard operation; real storefront preview matches saved definition                                              |
| 3 — Safe publication           | Drafts, revision conflicts, publish/restore and cache invalidation on Cloudflare                                         | Draft invisible publicly; conflict handled without data loss; publish visible after invalidation; restore works; two-tenant isolation and sandbox checkout pass |
| 4 — Commerce blocks            | Extend catalogue only for supported product, collection and communication flows                                          | Real data, loading/empty/error states; unchanged price/inventory authority; provider sandbox proof where needed                                                 |
| 5 — AI editing                 | Natural-language request produces a validated document patch, reviewable before publish                                  | Unknown blocks/props and cross-store references rejected; patch can be undone; no generated executable code; no automatic publish                               |

Each phase gets a concrete implementation plan after Phase 0 identifies actual gaps. Reuse current packages and components before adding dependencies. Keep live backend launch work independent of this optional editor expansion. No completion dates or cost savings are asserted without sizing and measurement.

## Plasmic reference and reuse boundaries

Study component registration, properties, slots, variants, responsive editing, tree/canvas synchronization, history and serialization. Implement a constrained commerce editor suited to Ebda rather than adopting the full Studio by default.

The upstream [README license section](https://github.com/plasmicapp/plasmic#license) states that content outside `platform/` is MIT and `platform/` is AGPL. Verified 2026-10-07 against the [MIT license](https://github.com/plasmicapp/plasmic/blob/master/LICENSE.md) and [platform license](https://github.com/plasmicapp/plasmic/blob/master/LICENSE.platform.md). Any selected package needs pinned-version provenance, its actual license/dependency checks and required notices. This specification selects no Plasmic package and authorizes no copying of Studio source. Any future Studio reuse needs a separate licensing decision before adoption.

Ruling BUILDER-1 — extend the existing Ebda builder with a constrained registry and compatible page definitions. Evidence: existing builder, layout contract and API routes are present; wholesale replacement adds avoidable migration risk. Cost if wrong: compatibility work may constrain the new editor and need a later explicit migration.

Ruling BUILDER-2 — treat Plasmic as a reference; select no runtime dependency now. Evidence: split licensing and current Ebda components already provide a foundation. Cost if wrong: more implementation work than carefully selected compatible packages would require.

## Verification for future implementation

Exercise meaningful schema/history unit tests, save/publish/isolation integration tests, bilingual browser E2E, preview/publish load checks and merchant UAT on touched paths. Verify the deployed commit and rendered storefront after deployment. Record what remains unverified, including real provider behavior. This documentation change requires formatting, links, source-path checks and a sweep of existing builder/spec consumers; it does not require application test reruns.
