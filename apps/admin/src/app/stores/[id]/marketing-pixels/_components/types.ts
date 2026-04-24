import type { ReactNode } from 'react';

/**
 * Shared types for the marketing-pixels feature. The PixelConfig shape covers
 * the simple `{ enabled, pixelId }` platforms (Meta, TikTok, Snapchat, Twitter)
 * while the MarketingPixels map carries the per-platform variants we persist
 * on the Store document.
 */
export interface PixelConfig {
  enabled: boolean;
  pixelId: string;
  accessToken?: string;
  conversionLabel?: string;
}

export interface MarketingPixels {
  meta?: PixelConfig;
  tiktok?: PixelConfig;
  snapchat?: PixelConfig;
  googleAnalytics?: { enabled: boolean; measurementId: string };
  googleTagManager?: { enabled: boolean; containerId: string };
  googleAds?: { enabled: boolean; conversionId: string; conversionLabel?: string };
  twitter?: PixelConfig;
  pinterest?: { enabled: boolean; tagId: string };
}

export interface StoreData {
  id: string;
  name: string;
  marketingPixels: MarketingPixels;
}

/**
 * Generic pixel config row used internally when rendering the list. Every
 * platform writes into a different field, so we widen the type to cover all
 * known ID fields.
 */
export interface PixelConfigRow {
  enabled?: boolean;
  pixelId?: string;
  measurementId?: string;
  containerId?: string;
  conversionId?: string;
  tagId?: string;
  accessToken?: string;
  conversionLabel?: string;
}

export interface Platform {
  id: string;
  /** Translation key segment under `marketingPixels.platforms` */
  i18nKey: string;
  icon: ReactNode;
  color: string;
  idPlaceholder: string;
  hasAccessToken?: boolean;
  hasConversionLabel?: boolean;
  docsUrl: string;
}
