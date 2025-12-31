'use client';

import { forwardRef, useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../utils/cn';

export interface ProductImage {
  id: string;
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface ProductGalleryProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Array of product images */
  images: ProductImage[];
  /** Product name for alt text fallback */
  productName: string;
  /** Show in RTL format */
  isRtl?: boolean;
  /** Enable lightbox on click */
  enableLightbox?: boolean;
  /** Enable zoom on hover */
  enableZoom?: boolean;
  /** Thumbnail position */
  thumbnailPosition?: 'bottom' | 'left' | 'right';
  /** Aspect ratio for main image */
  aspectRatio?: 'square' | '4:3' | '3:4' | '16:9';
  /** Show image counter */
  showCounter?: boolean;
}

const aspectRatioStyles = {
  square: 'aspect-square',
  '4:3': 'aspect-[4/3]',
  '3:4': 'aspect-[3/4]',
  '16:9': 'aspect-video',
};

/**
 * Product image gallery with thumbnails, lightbox, and zoom.
 */
export const ProductGallery = forwardRef<HTMLDivElement, ProductGalleryProps>(
  (
    {
      images,
      productName,
      isRtl = false,
      enableLightbox = true,
      enableZoom = true,
      thumbnailPosition = 'bottom',
      aspectRatio = 'square',
      showCounter = true,
      className,
      ...props
    },
    ref
  ) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isLightboxOpen, setIsLightboxOpen] = useState(false);
    const [zoomPosition, setZoomPosition] = useState({ x: 0, y: 0 });
    const [isZooming, setIsZooming] = useState(false);

    const selectedImage = images[selectedIndex] || null;

    const handlePrevious = useCallback(() => {
      setSelectedIndex(prev => (prev === 0 ? images.length - 1 : prev - 1));
    }, [images.length]);

    const handleNext = useCallback(() => {
      setSelectedIndex(prev => (prev === images.length - 1 ? 0 : prev + 1));
    }, [images.length]);

    const handleKeyDown = useCallback(
      (e: KeyboardEvent) => {
        if (!isLightboxOpen) return;
        if (e.key === 'Escape') setIsLightboxOpen(false);
        if (e.key === 'ArrowLeft') {
          if (isRtl) handleNext();
          else handlePrevious();
        }
        if (e.key === 'ArrowRight') {
          if (isRtl) handlePrevious();
          else handleNext();
        }
      },
      [isLightboxOpen, isRtl, handleNext, handlePrevious]
    );

    useEffect(() => {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    useEffect(() => {
      if (isLightboxOpen) {
        document.body.style.overflow = 'hidden';
      } else {
        document.body.style.overflow = '';
      }
      return () => {
        document.body.style.overflow = '';
      };
    }, [isLightboxOpen]);

    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!enableZoom) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      setZoomPosition({ x, y });
    };

    if (images.length === 0) {
      return (
        <div
          ref={ref}
          className={cn(
            'bg-muted rounded-lg flex items-center justify-center',
            aspectRatioStyles[aspectRatio],
            className
          )}
          {...props}
        >
          <svg
            className="w-16 h-16 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        </div>
      );
    }

    const isVertical = thumbnailPosition === 'left' || thumbnailPosition === 'right';

    return (
      <>
        <div
          ref={ref}
          className={cn(
            'flex gap-4',
            isVertical ? 'flex-row' : 'flex-col',
            thumbnailPosition === 'right' && 'flex-row-reverse',
            className
          )}
          dir={isRtl ? 'rtl' : 'ltr'}
          {...props}
        >
          {/* Thumbnails */}
          {images.length > 1 && (
            <div
              className={cn(
                'flex gap-2',
                isVertical ? 'flex-col w-20' : 'flex-row overflow-x-auto'
              )}
              role="tablist"
              aria-label={isRtl ? 'معرض الصور' : 'Image gallery'}
            >
              {images.map((image, index) => (
                <button
                  key={image.id}
                  onClick={() => setSelectedIndex(index)}
                  className={cn(
                    'flex-shrink-0 overflow-hidden rounded-lg border-2 transition-all',
                    isVertical ? 'w-full aspect-square' : 'w-16 h-16',
                    selectedIndex === index
                      ? 'border-primary ring-2 ring-primary/20'
                      : 'border-transparent hover:border-muted-foreground/30'
                  )}
                  role="tab"
                  aria-selected={selectedIndex === index}
                  aria-label={`${isRtl ? 'صورة' : 'Image'} ${index + 1}`}
                >
                  <img
                    src={image.url}
                    alt={image.alt || `${productName} ${index + 1}`}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          )}

          {/* Main Image */}
          <div className="flex-1 relative">
            <div
              className={cn(
                'relative overflow-hidden rounded-lg bg-muted cursor-pointer',
                aspectRatioStyles[aspectRatio]
              )}
              onClick={() => enableLightbox && setIsLightboxOpen(true)}
              onMouseEnter={() => enableZoom && setIsZooming(true)}
              onMouseLeave={() => setIsZooming(false)}
              onMouseMove={handleMouseMove}
              role="button"
              tabIndex={0}
              aria-label={isRtl ? 'اضغط لتكبير الصورة' : 'Click to enlarge image'}
            >
              {selectedImage && (
                <img
                  src={selectedImage.url}
                  alt={selectedImage.alt || productName}
                  className={cn(
                    'w-full h-full object-cover transition-transform duration-300',
                    isZooming && enableZoom && 'scale-150'
                  )}
                  style={
                    isZooming && enableZoom
                      ? {
                          transformOrigin: `${zoomPosition.x}% ${zoomPosition.y}%`,
                        }
                      : undefined
                  }
                />
              )}

              {/* Navigation Arrows */}
              {images.length > 1 && (
                <>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      handlePrevious();
                    }}
                    className={cn(
                      'absolute top-1/2 -translate-y-1/2 p-2 rounded-full',
                      'bg-background/80 backdrop-blur-sm hover:bg-background',
                      'transition-opacity opacity-0 group-hover:opacity-100',
                      isRtl ? 'right-2' : 'left-2'
                    )}
                    aria-label={isRtl ? 'الصورة السابقة' : 'Previous image'}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 19l-7-7 7-7"
                      />
                    </svg>
                  </button>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      handleNext();
                    }}
                    className={cn(
                      'absolute top-1/2 -translate-y-1/2 p-2 rounded-full',
                      'bg-background/80 backdrop-blur-sm hover:bg-background',
                      'transition-opacity opacity-0 group-hover:opacity-100',
                      isRtl ? 'left-2' : 'right-2'
                    )}
                    aria-label={isRtl ? 'الصورة التالية' : 'Next image'}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </button>
                </>
              )}

              {/* Counter */}
              {showCounter && images.length > 1 && (
                <div className="absolute bottom-2 right-2 px-2 py-1 rounded-full bg-background/80 backdrop-blur-sm text-xs font-medium">
                  {selectedIndex + 1} / {images.length}
                </div>
              )}

              {/* Zoom Icon */}
              {enableLightbox && (
                <div className="absolute top-2 right-2 p-2 rounded-full bg-background/80 backdrop-blur-sm">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"
                    />
                  </svg>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Lightbox */}
        {enableLightbox &&
          isLightboxOpen &&
          typeof window !== 'undefined' &&
          createPortal(
            <div
              className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
              onClick={() => setIsLightboxOpen(false)}
              role="dialog"
              aria-modal="true"
              aria-label={isRtl ? 'معرض الصور' : 'Image lightbox'}
            >
              {/* Close Button */}
              <button
                onClick={() => setIsLightboxOpen(false)}
                className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                aria-label={isRtl ? 'إغلاق' : 'Close'}
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>

              {/* Image */}
              <img
                src={selectedImage?.url}
                alt={selectedImage?.alt || productName}
                className="max-w-[90vw] max-h-[90vh] object-contain"
                onClick={e => e.stopPropagation()}
              />

              {/* Navigation */}
              {images.length > 1 && (
                <>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      handlePrevious();
                    }}
                    className={cn(
                      'absolute top-1/2 -translate-y-1/2 p-3 rounded-full',
                      'bg-white/10 hover:bg-white/20 text-white transition-colors',
                      isRtl ? 'right-4' : 'left-4'
                    )}
                    aria-label={isRtl ? 'الصورة السابقة' : 'Previous image'}
                  >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 19l-7-7 7-7"
                      />
                    </svg>
                  </button>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      handleNext();
                    }}
                    className={cn(
                      'absolute top-1/2 -translate-y-1/2 p-3 rounded-full',
                      'bg-white/10 hover:bg-white/20 text-white transition-colors',
                      isRtl ? 'left-4' : 'right-4'
                    )}
                    aria-label={isRtl ? 'الصورة التالية' : 'Next image'}
                  >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </button>
                </>
              )}

              {/* Counter */}
              {images.length > 1 && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-white/10 text-white text-sm">
                  {selectedIndex + 1} / {images.length}
                </div>
              )}
            </div>,
            document.body
          )}
      </>
    );
  }
);

ProductGallery.displayName = 'ProductGallery';
