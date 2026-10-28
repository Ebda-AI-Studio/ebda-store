# R-EBDA-3D-1

> Section: 2026-10-07 — Product 3D models + AR (R-EBDA-3D-\*)

Ruling R-EBDA-3D-1 — the viewer is built on three.js primitives (`GLTFLoader`, `OrbitControls`, `RoomEnvironment`, `MeshoptDecoder`, `USDZExporter`) in `packages/ui/src/model3d`, not on `<model-viewer>`. Evidence: `@google/model-viewer@4.3.1` (latest, 2026-06-04) declares peer `three@^0.183.0` (= 0.183.x only) and `apps/web` ships `three@0.184.0`; `npm install @google/model-viewer@4.3.1 -w apps/web --dry-run` fails with ERESOLVE. Forcing the peer runs an unverified pair, a second three doubles the 3D bundle, downgrading three touches the hero shader. No new package enters the tree (`three` is MIT and already installed; `packages/ui` now declares it). Cost if wrong: we maintain ~480 lines of viewer that model-viewer would have given us (WebXR, hotspots); revisit when model-viewer accepts three ≥ 0.184.
