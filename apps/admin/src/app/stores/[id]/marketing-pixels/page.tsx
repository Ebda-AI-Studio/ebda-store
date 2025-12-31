'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';

// Marketing pixel platform configuration
const PLATFORMS = [
  {
    id: 'meta',
    name: 'Meta Pixel',
    description: 'Track conversions from Facebook and Instagram ads',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.477 2 2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.879V14.89h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.989C18.343 21.129 22 16.99 22 12c0-5.523-4.477-10-10-10z" />
      </svg>
    ),
    color: 'bg-blue-600',
    idLabel: 'Pixel ID',
    idPlaceholder: '123456789012345',
    hasAccessToken: true,
    docsUrl: 'https://developers.facebook.com/docs/meta-pixel',
  },
  {
    id: 'tiktok',
    name: 'TikTok Pixel',
    description: 'Track conversions from TikTok ads',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-5.2 1.74 2.89 2.89 0 012.31-4.64 2.93 2.93 0 01.88.13V9.4a6.84 6.84 0 00-1-.05A6.33 6.33 0 005 20.1a6.34 6.34 0 0010.86-4.43v-7a8.16 8.16 0 004.77 1.52v-3.4a4.85 4.85 0 01-1-.1z" />
      </svg>
    ),
    color: 'bg-black',
    idLabel: 'Pixel ID',
    idPlaceholder: 'CXXXXXXXXXXXXXXXXXX',
    hasAccessToken: true,
    docsUrl: 'https://ads.tiktok.com/help/article?aid=10021',
  },
  {
    id: 'snapchat',
    name: 'Snapchat Pixel',
    description: 'Track conversions from Snapchat ads',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-.809-.33-1.227-.719-1.212-1.168 0-.359.285-.69.735-.838.165-.045.359-.074.523-.074.12 0 .285.015.465.074.36.18.735.301 1.032.301.196 0 .33-.045.406-.089-.009-.18-.024-.359-.03-.539 0-.015-.003-.044-.003-.059-.104-1.627-.225-3.653.299-4.847C7.859 1.07 11.216.793 12.206.793z" />
      </svg>
    ),
    color: 'bg-yellow-400',
    idLabel: 'Pixel ID',
    idPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    docsUrl: 'https://businesshelp.snapchat.com/s/article/snap-pixel-about',
  },
  {
    id: 'googleAnalytics',
    name: 'Google Analytics 4',
    description: 'Track website traffic and user behavior',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M22.84 2.9987V20.9987C22.8411 21.5288 22.6317 22.0381 22.2576 22.4131C21.8835 22.7882 21.3747 22.999 20.8446 22.9999H17.0046C16.4754 22.9977 15.968 22.7864 15.595 22.4116C15.222 22.0369 15.013 21.5285 15.0146 20.9993V2.9993C15.0134 2.46945 15.2227 1.96061 15.5969 1.58573C15.971 1.21085 16.4798 1.0001 17.0099 0.999287H20.8499C21.3788 1.00149 21.8857 1.21309 22.258 1.58789C22.6303 1.9627 22.8388 2.47082 22.8379 2.9999L22.84 2.9987Z" />
        <path d="M15.0146 14.9987V20.9987C15.0158 21.5285 14.8065 22.0374 14.4323 22.4122C14.0582 22.7871 13.5494 22.9979 13.0193 22.9987H9.17929C8.64897 22.9987 8.14035 22.7879 7.7653 22.413C7.39025 22.038 7.17929 21.5295 7.17929 20.9993V14.9993C7.17929 14.4691 7.39025 13.9606 7.7653 13.5857C8.14035 13.2108 8.64897 13 9.17929 13H13.0193C13.5495 13.0008 14.0583 13.2117 14.4324 13.5866C14.8066 13.9614 15.0158 14.4703 15.0146 15.0001V14.9987Z" />
        <path d="M7.22 20.9987C7.22 22.1033 6.32457 22.9987 5.22 22.9987C4.11543 22.9987 3.22 22.1033 3.22 20.9987C3.22 19.8941 4.11543 18.9987 5.22 18.9987C6.32457 18.9987 7.22 19.8941 7.22 20.9987Z" />
      </svg>
    ),
    color: 'bg-orange-500',
    idLabel: 'Measurement ID',
    idPlaceholder: 'G-XXXXXXXXXX',
    docsUrl: 'https://developers.google.com/analytics/devguides/collection/ga4',
  },
  {
    id: 'googleTagManager',
    name: 'Google Tag Manager',
    description: 'Manage all your marketing tags in one place',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0L1.608 6v12L12 24l10.392-6V6zm-1.068 17.4l-4.788-4.788 1.932-1.932 2.856 2.856 5.94-5.94 1.932 1.932z" />
      </svg>
    ),
    color: 'bg-blue-500',
    idLabel: 'Container ID',
    idPlaceholder: 'GTM-XXXXXXX',
    docsUrl: 'https://developers.google.com/tag-manager',
  },
  {
    id: 'googleAds',
    name: 'Google Ads',
    description: 'Track conversions from Google Ads campaigns',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3.9987 17.9971L12 3.99707L20.0013 17.9971H3.9987ZM7.46426 16.4971H16.5357L12 8.73242L7.46426 16.4971Z" />
        <path d="M12 21.75C13.2426 21.75 14.25 20.7426 14.25 19.5C14.25 18.2574 13.2426 17.25 12 17.25C10.7574 17.25 9.75 18.2574 9.75 19.5C9.75 20.7426 10.7574 21.75 12 21.75Z" />
      </svg>
    ),
    color: 'bg-green-500',
    idLabel: 'Conversion ID',
    idPlaceholder: 'AW-XXXXXXXXX',
    hasConversionLabel: true,
    docsUrl: 'https://support.google.com/google-ads/answer/6095821',
  },
  {
    id: 'twitter',
    name: 'Twitter/X Pixel',
    description: 'Track conversions from Twitter/X ads',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
    color: 'bg-black',
    idLabel: 'Pixel ID',
    idPlaceholder: 'xxxxx',
    docsUrl:
      'https://business.twitter.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites.html',
  },
  {
    id: 'pinterest',
    name: 'Pinterest Tag',
    description: 'Track conversions from Pinterest ads',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0C5.373 0 0 5.372 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738.098.119.112.224.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.631-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12 0-6.628-5.373-12-12-12z" />
      </svg>
    ),
    color: 'bg-red-600',
    idLabel: 'Tag ID',
    idPlaceholder: '1234567890123',
    docsUrl: 'https://help.pinterest.com/en/business/article/install-the-pinterest-tag',
  },
];

interface PixelConfig {
  enabled: boolean;
  pixelId: string;
  accessToken?: string;
  conversionLabel?: string;
}

interface MarketingPixels {
  meta?: PixelConfig;
  tiktok?: PixelConfig;
  snapchat?: PixelConfig;
  googleAnalytics?: { enabled: boolean; measurementId: string };
  googleTagManager?: { enabled: boolean; containerId: string };
  googleAds?: { enabled: boolean; conversionId: string; conversionLabel?: string };
  twitter?: PixelConfig;
  pinterest?: { enabled: boolean; tagId: string };
}

interface StoreData {
  id: string;
  name: string;
  marketingPixels: MarketingPixels;
}

export default function MarketingPixelsPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [store, setStore] = useState<StoreData | null>(null);
  const [pixels, setPixels] = useState<MarketingPixels>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [expandedPlatform, setExpandedPlatform] = useState<string | null>(null);

  useEffect(() => {
    fetchStore();
  }, [storeId]);

  async function fetchStore() {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/admin/stores/${storeId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      const data = await response.json();

      if (data.success && data.data?.store) {
        setStore(data.data.store);
        setPixels(data.data.store.marketingPixels || {});
      }
    } catch (error) {
      console.error('Failed to fetch store:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
    setIsSaving(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/admin/stores/${storeId}/marketing-pixels`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ marketingPixels: pixels }),
        }
      );

      if (response.ok) {
        alert('Marketing pixels saved successfully!');
      } else {
        throw new Error('Failed to save');
      }
    } catch (error) {
      console.error('Failed to save marketing pixels:', error);
      alert('Failed to save marketing pixels');
    } finally {
      setIsSaving(false);
    }
  }

  function updatePixel(platformId: string, field: string, value: string | boolean) {
    setPixels(prev => {
      const current = (prev as Record<string, Record<string, unknown>>)[platformId] || {
        enabled: false,
      };
      return {
        ...prev,
        [platformId]: {
          ...current,
          [field]: value,
        },
      };
    });
  }

  function togglePlatform(platformId: string) {
    const current = (pixels as Record<string, { enabled?: boolean }>)[platformId];
    const isEnabled = current?.enabled || false;
    updatePixel(platformId, 'enabled', !isEnabled);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Store not found</p>
        <Link href="/stores" className="text-primary hover:underline mt-2 inline-block">
          Back to stores
        </Link>
      </div>
    );
  }

  return (
    <AdminLayout
      title="Marketing Pixels"
      subtitle="Configure tracking pixels to measure ad performance and conversions"
      actions={
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      }
    >
      <div className="space-y-6">
        {/* Info Banner */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <svg
              className="w-5 h-5 text-blue-600 mt-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-1">About Marketing Pixels</p>
              <p>
                Marketing pixels are small code snippets that track visitor behavior on your store.
                They help you measure the effectiveness of your advertising campaigns and optimize
                for conversions.
              </p>
            </div>
          </div>
        </div>

        {/* Platforms Grid */}
        <div className="space-y-4">
          {PLATFORMS.map(platform => {
            const config =
              (
                pixels as Record<
                  string,
                  {
                    enabled?: boolean;
                    pixelId?: string;
                    measurementId?: string;
                    containerId?: string;
                    conversionId?: string;
                    tagId?: string;
                    accessToken?: string;
                    conversionLabel?: string;
                  }
                >
              )[platform.id] || {};
            const isEnabled = config.enabled || false;
            const isExpanded = expandedPlatform === platform.id;

            // Get the appropriate ID field based on platform
            const getIdValue = () => {
              if (platform.id === 'googleAnalytics') return config.measurementId || '';
              if (platform.id === 'googleTagManager') return config.containerId || '';
              if (platform.id === 'googleAds') return config.conversionId || '';
              if (platform.id === 'pinterest') return config.tagId || '';
              return config.pixelId || '';
            };

            const getIdField = () => {
              if (platform.id === 'googleAnalytics') return 'measurementId';
              if (platform.id === 'googleTagManager') return 'containerId';
              if (platform.id === 'googleAds') return 'conversionId';
              if (platform.id === 'pinterest') return 'tagId';
              return 'pixelId';
            };

            return (
              <div
                key={platform.id}
                className={`bg-white rounded-xl border transition-all ${
                  isEnabled ? 'border-primary/30 shadow-sm' : 'border-gray-200'
                }`}
              >
                {/* Platform Header */}
                <div
                  className="flex items-center justify-between p-4 cursor-pointer"
                  onClick={() => setExpandedPlatform(isExpanded ? null : platform.id)}
                >
                  <div className="flex items-center gap-4">
                    <div className={`p-2 rounded-lg text-white ${platform.color}`}>
                      {platform.icon}
                    </div>
                    <div>
                      <h3 className="font-medium">{platform.name}</h3>
                      <p className="text-sm text-gray-500">{platform.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    {/* Status Badge */}
                    <span
                      className={`px-2 py-1 text-xs font-medium rounded-full ${
                        isEnabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {isEnabled ? 'Active' : 'Inactive'}
                    </span>
                    {/* Toggle */}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        togglePlatform(platform.id);
                      }}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        isEnabled ? 'bg-primary' : 'bg-gray-300'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                          isEnabled ? 'left-5' : 'left-0.5'
                        }`}
                      />
                    </button>
                    {/* Expand Icon */}
                    <svg
                      className={`w-5 h-5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </div>
                </div>

                {/* Platform Config (Expanded) */}
                {isExpanded && (
                  <div className="border-t border-gray-100 p-4 space-y-4 bg-gray-50/50">
                    {/* Main ID Field */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {platform.idLabel}
                      </label>
                      <input
                        type="text"
                        value={getIdValue()}
                        onChange={e => updatePixel(platform.id, getIdField(), e.target.value)}
                        placeholder={platform.idPlaceholder}
                        disabled={!isEnabled}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary disabled:bg-gray-100 disabled:cursor-not-allowed"
                      />
                    </div>

                    {/* Access Token (for Meta, TikTok) */}
                    {platform.hasAccessToken && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Access Token (Optional - for Conversions API)
                        </label>
                        <input
                          type="password"
                          value={config.accessToken || ''}
                          onChange={e => updatePixel(platform.id, 'accessToken', e.target.value)}
                          placeholder="Enter access token for server-side tracking"
                          disabled={!isEnabled}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary disabled:bg-gray-100 disabled:cursor-not-allowed"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Access tokens enable server-side event tracking for better accuracy
                        </p>
                      </div>
                    )}

                    {/* Conversion Label (for Google Ads) */}
                    {platform.hasConversionLabel && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Conversion Label (Optional)
                        </label>
                        <input
                          type="text"
                          value={config.conversionLabel || ''}
                          onChange={e =>
                            updatePixel(platform.id, 'conversionLabel', e.target.value)
                          }
                          placeholder="e.g., AbC123def456"
                          disabled={!isEnabled}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary disabled:bg-gray-100 disabled:cursor-not-allowed"
                        />
                      </div>
                    )}

                    {/* Documentation Link */}
                    <div className="pt-2">
                      <a
                        href={platform.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                          />
                        </svg>
                        View documentation
                      </a>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Events Info */}
        <div className="bg-white rounded-xl border p-6">
          <h2 className="font-semibold text-lg mb-4">Tracked Events</h2>
          <p className="text-gray-600 mb-4">
            When pixels are enabled, the following e-commerce events are automatically tracked:
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { name: 'Page View', description: 'Every page visit' },
              { name: 'View Content', description: 'Product page views' },
              { name: 'Add to Cart', description: 'Items added to cart' },
              { name: 'Initiate Checkout', description: 'Checkout started' },
              { name: 'Purchase', description: 'Completed orders' },
              { name: 'Search', description: 'Product searches' },
              { name: 'Add to Wishlist', description: 'Wishlist additions' },
              { name: 'Lead', description: 'Contact form submissions' },
            ].map(event => (
              <div key={event.name} className="p-3 bg-gray-50 rounded-lg">
                <div className="font-medium text-sm">{event.name}</div>
                <div className="text-xs text-gray-500">{event.description}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
