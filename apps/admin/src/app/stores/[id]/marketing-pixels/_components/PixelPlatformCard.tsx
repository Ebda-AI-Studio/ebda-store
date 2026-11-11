'use client';

import { useId } from 'react';
import { useT } from '@/i18n/useT';
import { getIdField } from './platformsConfig';
import type { PixelConfigRow, Platform } from './types';

interface PixelPlatformCardProps {
  platform: Platform;
  config: PixelConfigRow;
  isExpanded: boolean;
  onExpand: () => void;
  onToggle: () => void;
  onFieldChange: (field: string, value: string) => void;
}

/**
 * Collapsible card for a single marketing-pixel platform. Handles the header
 * (logo, name, toggle, expand chevron) and the expanded config form (main ID,
 * optional access token / conversion label, docs link).
 */
export function PixelPlatformCard({
  platform,
  config,
  isExpanded,
  onExpand,
  onToggle,
  onFieldChange,
}: PixelPlatformCardProps) {
  const t = useT('marketingPixels');
  const tPlatform = useT(`marketingPixels.platforms.${platform.i18nKey}`);
  const isEnabled = config.enabled || false;
  const contentId = useId();

  const getIdValue = (): string => {
    if (platform.id === 'googleAnalytics') return config.measurementId || '';
    if (platform.id === 'googleTagManager') return config.containerId || '';
    if (platform.id === 'googleAds') return config.conversionId || '';
    if (platform.id === 'pinterest') return config.tagId || '';
    return config.pixelId || '';
  };

  return (
    <div
      className={`bg-card rounded-xl border transition-all ${
        isEnabled ? 'border-primary/30 shadow-sm' : 'border-border'
      }`}
    >
      {/* Header */}
      <button
        data-ui="row"
        type="button"
        onClick={onExpand}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        className="flex w-full items-center justify-between p-4 bg-transparent border-0 text-start cursor-pointer hover:bg-muted/30 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <div className="flex items-center gap-4">
          <div className={`p-2 rounded-lg text-white ${platform.color}`}>{platform.icon}</div>
          <div>
            <h3 className="font-medium">{tPlatform('name')}</h3>
            <p className="text-sm text-muted-foreground">{tPlatform('description')}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span
            className={`px-2 py-1 text-xs font-medium rounded-full ${
              isEnabled
                ? 'bg-success/10 text-success-ink dark:bg-success/30 dark:text-success-ink'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {isEnabled ? t('status.active') : t('status.inactive')}
          </span>
          {/* Toggle is rendered as a span styled like a switch because nested
              buttons are invalid HTML; clicks here stop propagation so the
              outer expand button does not fire. */}
          <span
            role="switch"
            tabIndex={0}
            aria-checked={isEnabled}
            aria-label={t('toggleAriaLabel')}
            onClick={e => {
              e.stopPropagation();
              onToggle();
            }}
            onKeyDown={e => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                onToggle();
              }
            }}
            className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              isEnabled ? 'bg-primary' : 'bg-border'
            }`}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 bg-card rounded-full shadow transition-transform ${
                isEnabled ? 'start-5' : 'start-0.5'
              }`}
            />
          </span>
          <svg
            aria-hidden="true"
            className={`w-5 h-5 text-muted-foreground transition-transform ${
              isExpanded ? 'rotate-180' : ''
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Expanded config */}
      {isExpanded && (
        <div id={contentId} className="border-t border-border p-4 space-y-4 bg-muted/50">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {tPlatform('idLabel')}
            </label>
            <input
              type="text"
              value={getIdValue()}
              onChange={e => onFieldChange(getIdField(platform.id), e.target.value)}
              placeholder={platform.idPlaceholder}
              disabled={!isEnabled}
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary disabled:bg-muted disabled:cursor-not-allowed"
            />
          </div>

          {platform.hasAccessToken && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('fields.accessTokenLabel')}
              </label>
              <input
                type="password"
                autoComplete="off"
                value={config.accessToken || ''}
                onChange={e => onFieldChange('accessToken', e.target.value)}
                placeholder={t('fields.accessTokenPlaceholder')}
                disabled={!isEnabled}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary disabled:bg-muted disabled:cursor-not-allowed"
              />
              <p className="text-xs text-muted-foreground mt-1">{t('fields.accessTokenHelp')}</p>
            </div>
          )}

          {platform.hasConversionLabel && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('fields.conversionLabelLabel')}
              </label>
              <input
                type="text"
                value={config.conversionLabel || ''}
                onChange={e => onFieldChange('conversionLabel', e.target.value)}
                placeholder={t('fields.conversionLabelPlaceholder')}
                disabled={!isEnabled}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary disabled:bg-muted disabled:cursor-not-allowed"
              />
            </div>
          )}

          <div className="pt-2">
            <a
              href={platform.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
              {t('viewDocumentation')}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
