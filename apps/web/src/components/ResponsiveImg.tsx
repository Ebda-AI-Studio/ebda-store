import type { ImgHTMLAttributes } from 'react';
import { imageSrcSet } from '../lib/image-loader';

/**
 * A plain `<img>` with a real `srcset` + `sizes` for the paths that cannot use `next/image`
 * (section images, lightbox, footer logo). Always lazy unless told otherwise, always async-decoded.
 * `maxWidth` caps the widest candidate to what the slot can ever show at 2x.
 */
export function ResponsiveImg({
  src,
  sizes,
  maxWidth,
  loading = 'lazy',
  alt,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  sizes: string;
  maxWidth?: number;
  alt: string;
}) {
  return (
    <img
      src={src}
      srcSet={imageSrcSet(src, maxWidth)}
      sizes={sizes}
      alt={alt}
      loading={loading}
      decoding="async"
      {...rest}
    />
  );
}
