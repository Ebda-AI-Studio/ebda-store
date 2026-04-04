/**
 * Image Optimization Utilities
 *
 * Provides utilities for:
 * - Generating responsive image srcsets
 * - Creating blur placeholders
 * - Image URL transformations
 * - Lazy loading helpers
 */

// ============================================
// Types
// ============================================

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ResponsiveImage {
  src: string;
  srcSet: string;
  sizes: string;
  width: number;
  height: number;
  placeholder?: string;
}

export interface ImageOptimizationOptions {
  quality?: number;
  format?: 'webp' | 'avif' | 'jpeg' | 'png' | 'auto';
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  position?: 'center' | 'top' | 'bottom' | 'left' | 'right';
}

// ============================================
// Constants
// ============================================

/**
 * Default breakpoints for responsive images
 */
export const IMAGE_BREAKPOINTS = [320, 480, 640, 768, 1024, 1280, 1536, 1920];

// ============================================
// URL Transformation
// ============================================

/**
 * Transform image URL with optimization parameters
 * Supports common image CDN patterns (Cloudinary, Imgix, etc.)
 */
export function transformImageUrl(
  url: string,
  width: number,
  options: ImageOptimizationOptions = {}
): string {
  const { quality = 80, format = 'auto', fit = 'cover' } = options;

  // Handle Cloudinary URLs
  if (url.includes('cloudinary.com')) {
    const parts = url.split('/upload/');
    if (parts.length === 2) {
      const transforms = [
        `w_${width}`,
        `q_${quality}`,
        `f_${format}`,
        `c_${fit === 'cover' ? 'fill' : fit === 'contain' ? 'fit' : 'scale'}`,
      ].join(',');
      return `${parts[0]}/upload/${transforms}/${parts[1]}`;
    }
  }

  // Handle Imgix URLs
  if (url.includes('imgix.net')) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}w=${width}&q=${quality}&auto=format,compress&fit=${fit}`;
  }

  // Handle Unsplash URLs
  if (url.includes('unsplash.com')) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}w=${width}&q=${quality}&auto=format&fit=crop`;
  }

  // Handle Supabase Storage URLs
  if (url.includes('supabase') && url.includes('/storage/')) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}width=${width}&quality=${quality}`;
  }

  // Return original URL if no transformation is applicable
  return url;
}

/**
 * Generate srcset for responsive images
 */
export function generateSrcSet(
  url: string,
  widths: number[] = IMAGE_BREAKPOINTS,
  options: ImageOptimizationOptions = {}
): string {
  return widths
    .map(width => {
      const transformedUrl = transformImageUrl(url, width, options);
      return `${transformedUrl} ${width}w`;
    })
    .join(', ');
}

/**
 * Generate sizes attribute for responsive images
 */
export function generateSizes(config: { breakpoint: number; size: string }[]): string {
  const sorted = [...config].sort((a, b) => b.breakpoint - a.breakpoint);
  const parts = sorted.map(({ breakpoint, size }) => `(min-width: ${breakpoint}px) ${size}`);
  // Add default size
  parts.push('100vw');
  return parts.join(', ');
}

// ============================================
// Image Loading States
// ============================================

export type ImageLoadState = 'idle' | 'loading' | 'loaded' | 'error';

// Generic type for browser Image (without DOM lib dependency)
type GenericImage = {
  onload: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
};
type ImageConstructor = { new (): GenericImage };

/**
 * Create image preloader (browser-only)
 */
export function preloadImage(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof globalThis === 'undefined') {
      resolve();
      return;
    }

    const g = globalThis as Record<string, unknown>;
    if (!g.Image) {
      resolve();
      return;
    }

    const ImageClass = g.Image as ImageConstructor;
    const img = new ImageClass();
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Get image dimensions from URL (browser-only)
 */
export function getImageDimensions(src: string): Promise<ImageDimensions> {
  return new Promise((resolve, reject) => {
    if (typeof globalThis === 'undefined') {
      reject(new Error('getImageDimensions only works in browser'));
      return;
    }

    const g = globalThis as Record<string, unknown>;
    if (!g.Image) {
      reject(new Error('Image constructor not available'));
      return;
    }

    const ImageClass = g.Image as ImageConstructor;
    const img = new ImageClass();
    img.onload = () => {
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    };
    img.onerror = reject;
    img.src = src;
  });
}
