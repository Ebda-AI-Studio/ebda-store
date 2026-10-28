# R-EBDA-COPY-10

> Section: 2026-10-07 — Marketing copy and design (R-EBDA-COPY-\*)

Ruling R-EBDA-COPY-10 — the Dahab 3D ring is built from three.js primitives (lathe band, prongs, faceted brilliant) with physically based metal and the procedural `RoomEnvironment`, not a downloaded glTF. Evidence: no third-party model to license or credit; the lazy chunk is ~550 KB raw (three.js), loaded only within ~900px of the section and never under reduced motion, and the posters (`public/ring/`, 9 metal x stone stills from `scripts/ring/make-posters.mjs`) cover first paint and reduced motion. Cost if wrong: a reviewer wants a more detailed jeweller's model; swap `ring-scene.ts` for a GLTFLoader + Draco model of the same API. **Superseded 2026-10-14 by Ruling MKT-2 / MKT-7: the ring, `ring-scene.ts` and `public/ring/` are deleted; the marketing 3D section runs the product's real viewer on two downloaded models.**
