# R-EBDA-3D-3

> Section: 2026-10-07 — Product 3D models + AR (R-EBDA-3D-\*)

Ruling R-EBDA-3D-3 — Draco (`KHR_draco_mesh_compression`) and KTX2 (`KHR_texture_basisu`) files are REJECTED in Phase 1 with a message to re-export with meshopt + WebP, instead of self-hosting decoder wasm now. Evidence: three decodes meshopt (bundled JS) and WebP (browser) with no extra download; Draco/Basis need `draco_decoder.wasm` + `basis_transcoder.wasm` served from our origin, which is Phase 2 together with server-side optimisation. Cost if wrong: merchants whose exporter defaults to Draco must run one extra command (documented in the help article).
