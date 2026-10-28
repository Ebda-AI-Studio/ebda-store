# R-EBDA-3D-6

> Section: 2026-10-07 — Product 3D models + AR (R-EBDA-3D-\*)

Ruling R-EBDA-3D-6 — accepted residual: `https://media.ebda.app` sends no CORS headers (probed 2026-10-07: no `access-control-allow-origin` for ebda.app, admin.ebda.app or a custom domain; OPTIONS → 403), so the viewer's `fetch` of the GLB fails in production until the bucket gets a CORS rule. The viewer then keeps the poster and says "3D view unavailable" (and reports `product_3d_load_failed`); iOS AR with an uploaded USDZ and Android Scene Viewer do not need CORS. The one-time `wrangler r2 bucket cors set ebda-media` step is in the plan doc; it was NOT applied by this branch (production change, not asked). Cost if wrong: a merchant uploads a model and shoppers see only the poster until the rule is set.
