'use client';

import { useState } from 'react';
import { PLATFORMS } from './platformsConfig';
import { PixelPlatformCard } from './PixelPlatformCard';
import type { MarketingPixels, PixelConfigRow } from './types';

interface PixelsListProps {
  pixels: MarketingPixels;
  onFieldChange: (platformId: string, field: string, value: string) => void;
  onToggle: (platformId: string) => void;
}

/**
 * Renders the full platforms grid. Owns the local `expandedPlatform` state so
 * only one card is open at a time — state that has no reason to live on the
 * page component.
 */
export function PixelsList({ pixels, onFieldChange, onToggle }: PixelsListProps) {
  const [expandedPlatform, setExpandedPlatform] = useState<string | null>(null);
  const pixelsMap = pixels as Record<string, PixelConfigRow>;

  return (
    <div className="space-y-4">
      {PLATFORMS.map(platform => {
        const config = pixelsMap[platform.id] || {};
        const isExpanded = expandedPlatform === platform.id;

        return (
          <PixelPlatformCard
            key={platform.id}
            platform={platform}
            config={config}
            isExpanded={isExpanded}
            onExpand={() => setExpandedPlatform(isExpanded ? null : platform.id)}
            onToggle={() => onToggle(platform.id)}
            onFieldChange={(field, value) => onFieldChange(platform.id, field, value)}
          />
        );
      })}
    </div>
  );
}
