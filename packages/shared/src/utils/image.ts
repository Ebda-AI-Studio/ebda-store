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

/**
 * Predefined image sizes for common use cases
 */
export const IMAGE_PRESETS = {
  thumbnail: { width: 150, height: 150 },
  small: { width: 300, height: 300 },
  medium: { width: 600, height: 600 },
  large: { width: 1200, height: 1200 },
  hero: { width: 1920, height: 1080 },
  card: { width: 400, height: 400 },
  productGrid: { width: 500, height: 500 },
  productDetail: { width: 800, height: 800 },
  banner: { width: 1600, height: 600 },
  avatar: { width: 100, height: 100 },
  logo: { width: 200, height: 80 },
} as const;

export type ImagePreset = keyof typeof IMAGE_PRESETS;

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

/**
 * Get complete responsive image attributes
 */
export function getResponsiveImage(
  url: string,
  dimensions: ImageDimensions,
  options: {
    widths?: number[];
    sizes?: { breakpoint: number; size: string }[];
    optimization?: ImageOptimizationOptions;
  } = {}
): ResponsiveImage {
  const {
    widths = IMAGE_BREAKPOINTS.filter(w => w <= dimensions.width * 2),
    sizes = [
      { breakpoint: 1280, size: '50vw' },
      { breakpoint: 768, size: '75vw' },
    ],
    optimization = {},
  } = options;

  return {
    src: transformImageUrl(url, dimensions.width, optimization),
    srcSet: generateSrcSet(url, widths, optimization),
    sizes: generateSizes(sizes),
    width: dimensions.width,
    height: dimensions.height,
  };
}

// ============================================
// Placeholder Generation
// ============================================

/**
 * Generate a simple SVG blur placeholder
 */
export function generatePlaceholder(
  width: number,
  height: number,
  color: string = '#e5e7eb'
): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
      <rect fill="${color}" width="100%" height="100%"/>
    </svg>
  `.trim();

  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/**
 * Generate a shimmer placeholder animation
 */
export function generateShimmerPlaceholder(width: number, height: number): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="shimmer" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#f3f4f6">
            <animate attributeName="offset" values="-2;1" dur="2s" repeatCount="indefinite"/>
          </stop>
          <stop offset="50%" stop-color="#e5e7eb">
            <animate attributeName="offset" values="-1;2" dur="2s" repeatCount="indefinite"/>
          </stop>
          <stop offset="100%" stop-color="#f3f4f6">
            <animate attributeName="offset" values="0;3" dur="2s" repeatCount="indefinite"/>
          </stop>
        </linearGradient>
      </defs>
      <rect fill="url(#shimmer)" width="100%" height="100%"/>
    </svg>
  `.trim();

  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// ============================================
// Aspect Ratio Utilities
// ============================================

/**
 * Calculate height from width and aspect ratio
 */
export function calculateHeight(width: number, aspectRatio: string): number {
  const [w, h] = aspectRatio.split(':').map(Number);
  return Math.round((width * h) / w);
}

/**
 * Calculate width from height and aspect ratio
 */
export function calculateWidth(height: number, aspectRatio: string): number {
  const [w, h] = aspectRatio.split(':').map(Number);
  return Math.round((height * w) / h);
}

/**
 * Get aspect ratio from dimensions
 */
export function getAspectRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
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
 * Preload multiple images
 */
export function preloadImages(sources: string[]): Promise<void[]> {
  return Promise.all(sources.map(preloadImage));
}

// ============================================
// Validation
// ============================================

/**
 * Check if URL is a valid image URL
 */
export function isImageUrl(url: string): boolean {
  if (!url) return false;

  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();

    // Check common image extensions
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.bmp'];
    if (imageExtensions.some(ext => pathname.endsWith(ext))) {
      return true;
    }

    // Check common image CDN patterns
    const imageCdnPatterns = [
      'unsplash.com',
      'cloudinary.com',
      'imgix.net',
      'images.pexels.com',
      'images.unsplash.com',
    ];
    if (imageCdnPatterns.some(pattern => urlObj.hostname.includes(pattern))) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
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

// ============================================
// Next.js Image Loader
// ============================================

/**
 * Custom loader for Next.js Image component
 * Can be used with various image CDNs
 */
export function createNextImageLoader(cdnType: 'cloudinary' | 'imgix' | 'custom') {
  return ({ src, width, quality }: { src: string; width: number; quality?: number }) => {
    const q = quality || 75;

    switch (cdnType) {
      case 'cloudinary':
        return transformImageUrl(src, width, { quality: q, format: 'auto' });
      case 'imgix':
        return `${src}?w=${width}&q=${q}&auto=format`;
      default:
        return transformImageUrl(src, width, { quality: q });
    }
  };
}
