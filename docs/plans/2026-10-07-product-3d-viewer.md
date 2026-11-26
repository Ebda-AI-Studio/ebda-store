# Product 3D viewer + AR (design + implementation plan)

Approved by Ahmad 2026-10-07. Branch `feat/product-3d`. Rulings `R-EBDA-3D-*` in `docs/RULINGS.md`.

## Finish line (Phase 1)

- **Must work:** a merchant on any plan uploads a `.glb` on the admin product page, sees it in a
  preview, sets alt text + a poster + AR on/off, maps option values (Metal: Gold / White gold / Rose gold,
  Colour: …) to a material colour/metal or to a glTF `KHR_materials_variants` variant, and the storefront
  PDP shows a "View in 3D" control that loads the model on demand, rotates/zooms (pointer + keyboard),
  recolours live as the shopper taps option pills, and offers "View in your space" on iOS (Quick Look)
  and Android (Scene Viewer).
- **Exercised by:** API integration tests on a local Postgres container (upload → row → public payload →
  bindings → delete; RLS proof for both new tables as `ebda_app`; per-store override off → 403), unit tests for the GLB /
  USDZ validators and the binding resolver, a render test of the PDP 3D toggle, typecheck of every
  workspace. Mutation checks on the validator and the feature gate.
- **Must NOT change:** the PDP for any product without a model or any store without the feature (no extra
  bytes, no layout shift — the 3D control is not rendered at all); the image upload pipeline; billing /
  plan-limit code (owned by other branches).
- **Done =** all of the above green, PR open, not merged, not deployed.

## Shape of the store's data

There is **one** PDP render path: `apps/web/src/app/products/[slug]/ProductDetailClient.tsx`, used by both
the header-routed and the `tenant-store/[tenant]/[locale]` trees and by all 5 templates (the templates
differ only in cards/header/footer/hero; none owns a product page). The visual builder
(`packages/shared/src/builder`, `apps/web/src/builder/render/PageRenderer.tsx`) has no product-detail
section type — `product-carousel` renders cards. **There is no quick view** anywhere in `apps/web`
(`grep -ri quickview` is empty), so "quick view" is a Phase 2 item that starts by building quick view.

## Viewer choice — three.js primitives, not `<model-viewer>` (Ruling R-EBDA-3D-1)

`<model-viewer>` (Apache-2.0) was the preferred option. It cannot be installed cleanly:
`@google/model-viewer@4.3.1` (latest, 2026-06-04) declares `peerDependencies: { three: "^0.183.0" }`,
which for a 0.x caret means **0.183.x only**, and `apps/web` already ships `three@0.184.0` (MIT) for the
hero shader. `npm install` fails with `ERESOLVE`. The ways around it are all worse:
`--legacy-peer-deps`/an override runs model-viewer against a three it was not built for (unverified
combination, silent breakage risk); a second copy of three doubles the 3D bundle; downgrading three
changes an unrelated surface.

So the viewer is built from the primitives model-viewer itself wraps, all inside the `three` package we
already ship (no new dependency): `GLTFLoader`, `OrbitControls`, `RoomEnvironment` (PBR lighting with no
HDR download), `MeshoptDecoder` (pure JS, embedded wasm) and `USDZExporter` (on-device USDZ for iOS AR —
the same trick model-viewer uses). It lives in `packages/ui/src/model3d/` (subpath `@ebda/ui/model3d`)
so the admin preview and the storefront run the same code, and it is only ever reached through
`next/dynamic(..., { ssr: false })` on an explicit tap, so three is never in the initial bundle.
Revisit model-viewer when a release accepts three ≥ 0.184.

## Formats, caps, validation (server-side, no trust in the client)

| Asset    | Accepted                                         | Cap   | Server check (`packages/shared/src/model3d.ts`)                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model    | `.glb` (binary glTF 2.0) only                    | 15 MB | magic `glTF`, version 2, header length == byte length, chunk 0 = JSON (4-byte aligned, in bounds, parses, `asset.version` 2.x), optional chunk 1 = `BIN`, no external `uri` on any buffer or image (self-contained only), `extensionsRequired` ⊆ supported set, ≥ 1 mesh, ≤ 512 materials / 4 096 meshes, ≤ 2 000 000 vertices |
| AR (iOS) | `.usdz`, optional                                | 15 MB | ZIP local-header magic, first entry is `.usdc`/`.usda`/`.usd`, stored (method 0) as the USDZ spec requires                                                                                                                                                                                                                     |
| Poster   | image via the existing `/uploads/image` pipeline | 10 MB | existing pipeline; the PUT then requires the URL to be in our bucket under `stores/<storeId>/`                                                                                                                                                                                                                                 |

The client runs the same validator before uploading (fast feedback); the server runs it again and is the
gate. `.gltf` + side files, `.obj`, `.fbx` are rejected with a bilingual message pointing to the help
article (`gltf-transform` / Blender export settings).

**Supported required extensions:** `KHR_materials_*`, `KHR_texture_transform`, `KHR_mesh_quantization`,
`EXT_meshopt_compression`, `EXT_texture_webp`, `KHR_materials_variants`. **Rejected:**
`KHR_draco_mesh_compression` and `KHR_texture_basisu` (KTX2) — both need decoder wasm we would have to
self-host (Phase 2); the error tells the merchant to re-export with meshopt + WebP, which three decodes
with no extra download (Ruling R-EBDA-3D-3).

## Optimisation

Phase 1: **client guidance + cap.** The help article gives one command
(`npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress webp`) and the
validator returns soft warnings (over 8 MB, over 500 k vertices) that the admin card shows.

Phase 2: a background job (Inngest) running gltf-transform (`dedup → weld → simplify → meshopt → webp`)
and writing an optimised sibling object. **Not on Workers:** meshoptimizer/sharp need wasm/native modules
compiled at runtime, which Workers forbid (no `WebAssembly.compile` from bytes); it needs the Node runtime
(Railway) or a Container. Re-evaluated when Phase 2 starts.

## Storage + data model

R2 public bucket `ebda-media` (`https://media.ebda.app`), new tenant folder `models`:
`stores/<storeId>/models/<uuid>-<name>.glb|.usdz`. Store deletion already purges `stores/<storeId>/`.

```
product_models            one row per product (UNIQUE product_id), store_id, strict RLS
  model_url, model_bytes, usdz_url?, usdz_bytes?, poster_url?, alt_text?, alt_text_ar?, ar_enabled,
  materials jsonb  [{ index, name }]          extracted at upload, drives the mapping UI
  gltf_variants jsonb  [name]                 KHR_materials_variants names
  stats jsonb  { vertices, meshes, materials, textures, extensionsUsed }
product_model_bindings    store_id, strict RLS, model_id → product_models CASCADE,
                          option_value_id → product_option_values CASCADE
  kind 'material' | 'gltf_variant', target (material name / variant name),
  color #rrggbb?, metalness 0..1?, roughness 0..1?
  UNIQUE (model_id, option_value_id, kind, target)
```

Both tables carry `store_id` so the one strict policy applies directly (no EXISTS child policy).
Every URL column is registered in `apps/api/src/lib/r2-references.ts` (or the orphan sweep would delete
live models). Replace/delete go through `deleteR2ObjectIfOrphan` (deferred until after COMMIT).

**Why option values, not variants (Ruling R-EBDA-3D-4):** a ring with Size × Metal has 3 × 8 = 24
variants but only 3 metals; binding per option value is 3 rows and is correct for every variant that
carries the value, including variants added later. The storefront applies bindings for the shopper's
_partial_ selection (Metal picked, size not yet), which a variant binding cannot do.

## API

Router `apps/api/src/routes/product-model.routes.ts`, mounted at `/stores/:storeId/product-models`
**above** the `/stores/:storeId/products` and `/stores/:storeId` tenantContext mounts (prefix-match
fall-through, #1602): the upload must NOT run inside the 30 s request transaction, because a 15 MB upload
on an Egyptian mobile link can take longer than that.

| Route                                                                 | Gate                                                                                   | Context                                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /:productId` → model + product options (with value ids) + limits | auth, store access                                                                     | tenantContext                                                                                                               |
| `POST /:productId/glb` (multipart `file`)                             | `products:write`, `requireFeature('product_3d')`, upload limiters                      | none during upload; validate → R2 put → one `runInTenantContext` write; R2 object deleted if the write fails (compensation) |
| `POST /:productId/usdz`                                               | same                                                                                   | same                                                                                                                        |
| `PUT /:productId` alt text / AR / poster / remove USDZ                | `products:write`, feature                                                              | tenantContext                                                                                                               |
| `PUT /:productId/bindings` replace the set                            | `products:write`, feature                                                              | tenantContext                                                                                                               |
| `DELETE /:productId`                                                  | `products:write` (**not** feature-gated, so a downgraded merchant can still remove it) | tenantContext                                                                                                               |

Every write calls `invalidateStoreProductCaches(storeId)` (Redis `public:product:*` + the storefront's
`products:<storeId>` tag). Public payload: `GET /public/products/:slug` gains `model3d` (bindings resolved
to `{ optionName, value }` so the storefront matches them against its pill state); the route strips it
when `product_3d` is off for the store — after the Redis read, so the entitlement check is never stale by
the product cache (staleness class: entitlement → event-invalidated by FeatureService; the residual is
the existing edge cache, ≤ 60 s + SWR, same as every product field).

## Plan gating (Ruling R-EBDA-3D-2) — every plan

**Ahmad, 2026-10-07: 3D models are on ALL plans, Basic included — no plan gate.** (This replaces the
Growth+ proposal in the first draft of this plan.) New feature key `product_3d` sits in `STARTER_CORE`
(Basic/Growth/Business and hidden `pro`/`comped`/`founding_free` via their tiers) AND in the `free`
fallback baseline, so a lapsed store's PDP keeps its models. The key exists only so a super-admin
`StoreFeature` override can switch it off for one store (same "restrict by exception" pattern as
`whatsapp`). Per-file caps stay (15 MB GLB / 15 MB USDZ, 2 M vertices). The per-plan storage quota
(`maxStorageMb`) is declared but NOT enforced anywhere today (`plan-limit.service.ts`: "declared + shown,
not enforced") — models count toward it the day it is enforced; nothing new to wire now. The help
article's plan table gains a "3D product models + AR — Yes / Yes / Yes" row. `apps/marketing/src/lib/plans.ts`
also enumerates plan features but `apps/marketing` is owned by another branch right now — follow-up.

## Variant → material mapping UI (admin, v1)

Admin product page → **3D model** card: upload/replace GLB, optional USDZ, preview (same viewer), poster
("Use current view" captures the preview canvas → existing image upload, or upload any image), alt text
EN/AR, AR toggle, remove. Mapping table: for each option value → pick a material from the model (or a
glTF variant when the file has them) and a finish: Gold / White gold / Rose gold / Silver / Platinum
presets (PBR base colours, metalness 1, roughness 0.25) or a custom colour via `ColorField` (metalness 0).
Saved as one replace-the-set PUT. On model replace, bindings whose target no longer exists in the new
file are dropped (reported in the response) — never silently kept pointing at nothing.

## Storefront PDP

- The gallery gets a **"3D"** toggle only when `product.model3d` exists and `product_3d` is enabled.
  Tap → the image track is swapped for the viewer in the same box (same aspect → no layout shift); the
  poster (or first product image) shows until the model is ready. Nothing 3D is downloaded before the tap.
- Controls: drag/pinch (OrbitControls), keyboard (arrows rotate, +/- zoom, focusable canvas with an
  `aria-label` = merchant alt text or the product name), visible hint text, Photos button back.
- `prefers-reduced-motion`: no auto-rotate, no damping inertia.
- Option pills: the PDP passes the shopper's partial selection to the viewer, which applies matching
  bindings (material colour/metal or glTF variant). Pills with a colour binding show a swatch dot.
- AR: iOS (`a.relList.supports('ar')`) → merchant USDZ if uploaded, else USDZ exported on-device from the
  loaded scene with the current finish; Android → Scene Viewer intent with the GLB URL; desktop → hidden.
  Merchant can turn AR off.
- Budget: three + loaders load on tap (dynamic chunk); model ≤ 15 MB enforced; pixel ratio capped at 2;
  render loop stops when idle/offscreen; WebGL context disposed on unmount.

## Analytics (PostHog, consent-gated via `captureEvent`)

`product_3d_opened`, `product_3d_loaded` (ms, bytes), `product_3d_load_failed` (reason),
`product_3d_interacted` (first drag/zoom/key), `product_3d_ar_clicked` (platform, source usdz|generated|
scene-viewer), `product_3d_variant_applied`. All carry `storeId`, `productId`.

## Every data has a UI

`product_models` → admin product page 3D card (and the PDP). `product_model_bindings` → the mapping
table in that card. No other table. PostHog events are viewed in PostHog.

## Deploy prerequisite found while planning (not code)

`https://media.ebda.app` sends **no CORS headers** (probed 2026-10-07: no `access-control-allow-origin`
for `https://ebda.app`, `https://admin.ebda.app` or a custom domain; `OPTIONS` → 403). `<img>` does not
care, but the viewer `fetch`es the GLB, so until the bucket has a CORS rule the viewer falls back to the
poster with "3D view unavailable" (and fires `product_3d_load_failed`). One-time ops step before enabling
for a merchant (public bucket, so `*` exposes nothing new):

```bash
cat > /tmp/ebda-media-cors.json <<'JSON'
{"rules":[{"allowed":{"origins":["*"],"methods":["GET","HEAD"],"headers":["*"]},"maxAgeSeconds":86400}]}
JSON
npx wrangler r2 bucket cors set ebda-media --file /tmp/ebda-media-cors.json
curl -sI -H 'Origin: https://ebda.app' https://media.ebda.app/platform/instapay-qr.jpg | grep -i access-control-allow-origin
```

The CSP `connect-src` of web and admin also gains `https://media.ebda.app` (this PR).

## Phase 2 status (feat/3d-viewer-phase-2, LAUNCH-SCOPE-ALL-1)

Built: item 2 (`<Model3dChip>` on the 6 card render paths + the 3 adapters + listing/recommendation/wishlist payloads as `has3d`, CACHE CLASS BOUNDED-stale riding `invalidateStoreProductCaches`; the chip is a non-interactive `<span>` inside the card link whose tap opens the lazy quick view, keyboard users follow the link to the PDP), item 3 (`<Model3dQuickView>`, a Sheet over the PDP payload so `product_3d` is applied server-side), item 4 JSON-LD (`subjectOf` 3DModel GLB + optional USDZ), item 6 admin filter (`GET /products?has3d=true|false`, admin list "3D model" select). Android AR = Scene Viewer (ARCore) and iOS = Quick Look already ship in the viewer (Phase 1), hidden where unsupported; Ruling 3D-P2-AR-1: no in-page WebXR session now. Cost if wrong: Android devices without Scene Viewer lose the AR button's destination (it falls back to the product URL). NOT built: AI feed field, hotspots, Insights 3D engagement, server-side optimise job.

## Phase 2 remainder (original list)

1. Server-side optimisation job (see above) + self-hosted Draco/KTX2 decoders, then accept those files.
2. "3D" chip on product cards — all 8 card render paths in one change (CLAUDE.md platform rule).
3. Quick view (does not exist yet) with the viewer inside.
4. Product JSON-LD `subjectOf: 3DModel`; AI feed field.
5. WebXR in-browser AR on Android Chrome; hotspots/annotations; server-side poster rendering.
6. Admin products list filter "has 3D model"; 3D engagement in Insights.
