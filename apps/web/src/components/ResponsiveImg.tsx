import type { ImgHTMLAttributes } from 'react';
import { imageVariantSrcSet } from '@force/shared';

/**
 * A plain `<img>` that carries the upload pipeline's width ladder as a
 * `srcset` when `src` is one of our own raster media URLs (docs/RULINGS.md
 * PERF-STORE-3). For any other URL it renders exactly the `<img>` it was given
 * (no `srcset`, no `sizes`), so it is a drop-in for the templates' raw `<img>`
 * tags that cannot use `next/image` (unknown intrinsic size, `object-cover`
 * fills). Pass the `sizes` that match the slot, or the browser assumes 100vw.
 */
export function ResponsiveImg({
  src,
  sizes,
  alt,
  ...rest
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'srcSet'> & { src: string; alt: string }) {
  const srcSet = imageVariantSrcSet(src);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} {...(srcSet ? { srcSet, sizes: sizes ?? '100vw' } : {})} {...rest} />
  );
}
