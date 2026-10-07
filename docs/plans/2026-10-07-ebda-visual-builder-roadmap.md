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

## Store CMS and guided onboarding

Product direction from Ahmad: clients should manage stores through a visual CMS. Join setup and ongoing editing into one journey: choose a business/category preset → add store identity, logo and products → open the populated store in the editor → edit text/images/collections in place → preview mobile/desktop → save draft → publish.

Onboarding and the editor must use the same registry, document and renderer; onboarding is a guided entry to the CMS rather than a second configuration system. Resume unfinished setup without duplicating stores or resetting content. Populate previews with the merchant's own products when available; clearly label sample content and require its removal/replacement before publication. Default to a few useful controls, with advanced layout settings available separately. Inline guidance must identify what the merchant needs to supply without exposing implementation jargon.

Acceptance: a first-time Arabic-speaking merchant can complete setup and edit the resulting store without developer assistance; returning merchants reopen the same document; back navigation preserves inputs; retry does not create another store; desktop/mobile previews match the published store. Verify identity/product edits, failed uploads, empty catalogues, draft recovery and publish errors.

## Template discovery and refresh brief

Research date: 2026-10-07. This is a sourced shortlist and evaluation plan, not a claim that these templates have been visually tested, imported or integrated with Ebda. Ahmad considers the current templates unsatisfactory; inspect them against the rubric below before declaring specific defects.

| Source                                                                                        | Verified offering                                                                                                                                                                                                                                                       | Intended Ebda use                                                                                                | Constraints and next check                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Plasmic Marketplace](https://www.plasmic.app/marketplace)                                    | Community templates/components with an ecommerce category, including [E-commerce landing page](https://www.plasmic.app/marketplace/e-commerce-landing-page) and [Commerce storefront website](https://www.plasmic.app/marketplace/commerce-storefront-website) listings | Study CMS-friendly section composition and product presentation; shortlist project designs for merchant previews | Marketplace asset rights are not automatically the repository's MIT license. Check each item's terms, export format, paid requirements and assets. The commerce detail page could not be retrieved during this research; listing presence is verified, contents are not.                                                              |
| [Next.js Commerce](https://github.com/vercel/commerce) and [demo](https://demo.vercel.store/) | Next.js App Router storefront; upstream currently maintains the Shopify provider                                                                                                                                                                                        | Primary code candidate for selected storefront UI patterns/components, adapted to Ebda's API and renderer        | [MIT license](https://github.com/vercel/commerce/blob/main/license.md) verified. Preserve notices; independently verify asset licenses. Replace provider assumptions and test Cloudflare compatibility; do not adopt Shopify checkout or introduce Vercel hosting. Demo is a link for later visual review, not a reviewed screenshot. |
| [Shopify Horizon collection](https://themes.shopify.com/collections/horizon-themes)           | Ten free Shopify themes/presets, including Horizon, Fabric, Atelier and Savor                                                                                                                                                                                           | Visual references for catalogue, fashion, premium-brand and food-store layouts                                   | [Horizon source license](https://github.com/Shopify/horizon/blob/main/LICENSE.md) restricts use to Shopify interoperability. Do not import Horizon source into Ebda or redistribute derived themes. Free Shopify availability is not permission for reuse on Ebda. Build original Ebda implementations.                               |

Plasmic has templates, but availability does not mean turnkey Ebda templates: its project definitions, hosting/provider integration, asset rights and editor runtime need separate evaluation. No template or external library is selected for installation by this roadmap. No additional subscription is approved. Whisky's stated current hosting spend is $5/month for Cloudflare; document any incremental template/tool/runtime cost before selection.

### Initial Ebda preset families

Start with four proposed families, subject to merchant validation, rather than a large set of superficial color variants:

1. **Everyday catalogue:** search, clear categories, useful filters, product-focused grid and straightforward delivery/COD information.
2. **Fashion and boutique:** collection-led navigation, editorial image/text sections, variant/size presentation and mobile product browsing.
3. **Beauty and premium goods:** restrained typography, product details, genuine reviews and clear delivery/returns information.
4. **Food and gifts:** category-led browsing, clear product options, availability and delivery details. Do not promise scheduling or other unsupported backend features.

Each family is a Page Definition preset plus theme tokens and registry defaults. Merchants retain the same CMS actions across families. Template previews must show distinct composition with representative catalogue content, not just recolored cards. Existing customers keep their current templates; switching creates a reviewable draft and preserves products, settings and prior published revision.

### Selection rubric and acceptance

Compare existing and shortlisted designs using homepage, collection, product, search, cart and checkout-adjacent views at 360px, tablet and desktop widths. Score product clarity, navigation, typography/spacing, image cropping, CTA visibility, Arabic/RTL, keyboard/focus behavior, contrast, empty/error states and merchant editability. Record screenshots and concrete defects. Do not choose on homepage appearance alone.

For each adopted family, prove onboarding populates it correctly, every editable control has a visible renderer result, collection references belong to the store, long Arabic names/EGP prices fit, images have valid rights and fallbacks, and commerce state remains authoritative. Run storefront performance and Cloudflare build/runtime checks after adaptation. Treat selected code, images, fonts and icons as separate license/dependency decisions.

### Roadmap integration

- Phase 0 includes template inventory, screenshot comparison, merchant needs and source/license checks.
- Phase 1 defines presets through the same schema/registry as existing layouts.
- Phase 2 includes the guided onboarding-to-CMS handoff and family preview selector.
- Phase 3 proves safe template switching/publication with existing-store preservation.
- Phase 4 introduces additional preset families only with working commerce flows and merchant evidence.

Ruling BUILDER-3 — prefer original Ebda presets and selectively reusable MIT storefront code; treat Plasmic listings and Shopify designs as references until their individual reuse conditions are established. Evidence: marketplace listings exist, Next.js Commerce is MIT, and Horizon is restricted to Shopify use. Cost if wrong: adaptation work may be larger than a properly licensed ready-made template would require.

## Webstudio alongside Plasmic

Research date: 2026-10-07. Inspected [Webstudio repository](https://github.com/webstudio-is/webstudio), its package tree, CSS-engine README and official feature documentation. This is a targeted architectural review, not a source audit or proof of compatibility with Ebda. No packages are selected for installation.

Use Plasmic as the reference for registering Ebda components and constraining their props/slots; use Webstudio to inform merchant editing ergonomics and style consistency. Combine these ideas in Ebda's existing architecture rather than embedding two separate builders.

| Useful reference                                                                                | Proposed Ebda requirement                                                                                                                                                                                                                   | Phase / acceptance                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Content, Design and Preview modes](https://docs.webstudio.is/university/foundations/modes)     | Default merchant CMS mode edits approved content fields while protecting layout. Advanced design tools require a separate capability. Preview suppresses editing overlays.                                                                  | Phase 2: merchant edits text/images without moving protected structure; API enforces capabilities, not just hidden buttons; preview matches storefront. |
| [Reusable design tokens](https://docs.webstudio.is/university/foundations/design-tokens)        | Extend existing brand tokens with curated spacing, typography and card/button presets as needed. Show whether a value comes from a shared preset or local override; reset restores inheritance. Do not expose a full CSS editor by default. | Phases 1–2: a shared style change reaches all intended sections; local override stays local; reset and mobile overrides are predictable.                |
| [Slots](https://docs.webstudio.is/university/core-components/slot)                              | Investigate reusable navigation, announcement and footer compositions across pages. Define whether each is a shared reference or a detached copy; never leave propagation behavior implicit.                                                | Phase 2: edit a shared section once, verify all intended pages; detach changes only the copy; cross-store references fail validation.                   |
| [Headless CMS integration](https://docs.webstudio.is/university/foundations/cms)                | Bind catalogue sections to Ebda product/collection data rather than duplicating prices and availability inside page documents.                                                                                                              | Phases 1/4: collection ownership is checked; missing data has a deliberate empty state; commerce updates appear without manual page edits.              |
| [CSS engine](https://github.com/webstudio-is/webstudio/blob/main/packages/css-engine/README.md) | Study how one style representation can serve the live canvas and published output. Keep Ebda preview/render styles aligned.                                                                                                                 | Phases 1–3: compare preview and published styles at each supported viewport and RTL; no editor dependency enters storefront bundles.                    |

Repository navigation for Claude's next audit: [apps/builder](https://github.com/webstudio-is/webstudio/tree/main/apps/builder) for editor boundaries; [packages](https://github.com/webstudio-is/webstudio/tree/main/packages) includes `sdk-components-registry`, `react-sdk`, `sdk`, `css-engine`, `project`, `project-migrations`, `asset-uploader` and `template`. These names/directories were observed; package internals, dependency suitability and migration behavior still require inspection at a pinned commit. One attempted registry source URL was unavailable, so do not infer its API from its name.

### Licensing and scope

The upstream [README license section](https://github.com/webstudio-is/webstudio#license) describes core functionality as AGPL-3.0-or-later and identifies optional `sdk-components-animation` as proprietary under a separate EULA. Do not assume individual core packages are MIT. Before any code reuse, record the exact commit/package license, dependency notices and an explicit licensing decision. This roadmap adopts independently implemented concepts only; it does not authorize copying or integrating Webstudio core or its animation package.

Avoid importing Webstudio's unrestricted CSS surface, arbitrary scripts, external CMS credential handling or collaboration backend into the initial merchant CMS. Existing Ebda APIs own data and commerce; content/design permissions must integrate with current authorization. Curated merchant controls take priority over developer flexibility.

Phase 0 now includes a Plasmic/Webstudio comparison matrix mapped to actual Ebda gaps. Claude should size content/design modes, style inheritance and shared sections before adding them to the concrete implementation plan; already-working equivalents should be reused. These are documented target capabilities, not claims of current Ebda support.

Ruling BUILDER-4 — combine Plasmic's component-registration ideas with Webstudio's content modes and shared-style ergonomics through Ebda-owned implementations. Evidence: official docs describe these complementary features; Webstudio core uses AGPL and optional animations have separate proprietary terms. Cost if wrong: an independent implementation may cost more than a separately licensed integration.
