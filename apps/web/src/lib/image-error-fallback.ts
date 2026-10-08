/**
 * Inline `<head>` script: when a width-variant image 404s, fall back to the
 * original (docs/RULINGS.md PERF-STORE-3).
 *
 * The storefront asks for `<key>.w720.webp` & co. A legacy upload that predates
 * the variant pipeline (and has not been backfilled yet), or a variant that is
 * briefly missing, would otherwise leave a broken image. A capture-phase
 * `error` listener on the document sees the failure even before React has
 * hydrated, strips the variant suffix, drops any `srcset` / `<picture>` sources
 * that would re-select the missing file, and reloads the original once.
 * ~420 bytes, no dependencies, runs once per document.
 */
export const IMAGE_ERROR_FALLBACK_SCRIPT =
  "document.addEventListener('error',function(e){var t=e.target;if(!t||t.tagName!=='IMG')return;" +
  'var s=t.currentSrc||t.src;var m=s&&/^(.*\\.(?:jpe?g|png|webp))\\.w\\d{2,4}\\.webp$/i.exec(s);' +
  'if(!m||t.getAttribute("data-variant-fallback"))return;' +
  't.setAttribute("data-variant-fallback","1");' +
  'var p=t.parentNode;if(p&&p.tagName==="PICTURE"){var o=p.querySelectorAll("source");' +
  'for(var i=0;i<o.length;i++)p.removeChild(o[i]);}' +
  't.removeAttribute("srcset");t.removeAttribute("sizes");t.src=m[1];},true);';
