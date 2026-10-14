# Demo store photo credits

The example stores on ebda.app are illustrations; no real shop or product is shown.

## Template looks (public/looks)

The photos in the 15 template looks (Qamar, Souq, Jasmine, Lamma, Dahab) are illustrative and AI-generated with Cloudflare Workers AI FLUX.1 schnell (scripts/looks/gen.py, prompts in scripts/looks/prompts.py). They show no real shop, product or person and need no attribution.

## 3D models (public/3d)

Both models are derivatives, optimised for the web with gltf-transform (meshopt compression, WebP textures up to 1024 px); the licences below require the attribution shown. The same credit appears next to the viewer on the home page.

| File                   | Model                                                                                                                                                       | Author        | Source                     | License                                                       | Changes                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| qamar-sneaker.glb      | [MaterialsVariantsShoe](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/MaterialsVariantsShoe) (the sneaker, with its three colourways) | Shopify       | Khronos glTF-Sample-Assets | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)     | Optimised for the web (meshopt, WebP 1024 px); nothing else changed                                                       |
| brass-diya-lantern.glb | [Brass Diya Lantern](https://polyhaven.com/a/brass_diya_lantern)                                                                                            | Bhargav Kubal | Poly Haven                 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Hanging chain removed; optimised for the web (meshopt, WebP 1024 px). CC0 needs no attribution; it is given as a courtesy |

The stills in public/3d/stills are renders of these two models by scripts/3d/make-stills.mjs, so the same credit applies. public/3d/qr holds build-time QR codes (scripts/3d/make-qr.ts).

## Dahab story capture

The remaining Dahab story capture uses openly licensed stock (found via Openverse), resized and cropped. CC BY photos require the attribution below.

| File            | Photo                                                                                                                               | Author                                                    | Source   | License                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------- | ------------------------------------------------------------- |
| dahab-solitaire | [Simple elegant diamond ring](https://www.rawpixel.com/image/6036013/photo-image-public-domain-gold-fashion)                        | unknown (public domain)                                   | rawpixel | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| dahab-bands     | [Gold Wedding Rings](https://www.rawpixel.com/image/5925647/gold-wedding-rings-free-public-domain-cc0-photo)                        | unknown (public domain)                                   | rawpixel | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| dahab-bangle    | [Electrotype copy gold bracelet](https://www.rawpixel.com/image/9182917/electrotype-copy-gold-bracelet)                             | themet                                                    | rawpixel | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| dahab-chain     | [Gold chain recovered from the royal cemetery of Ur, Iraq 2550-2450 BCE](https://www.flickr.com/photos/44124324682@N01/33434970232) | [mharrsch](https://www.flickr.com/photos/44124324682@N01) | flickr   | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/)     |
