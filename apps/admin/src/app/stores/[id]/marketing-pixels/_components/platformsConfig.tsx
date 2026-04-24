import type { Platform } from './types';

/**
 * Static platform definitions. The display name / description come from the
 * i18n catalogue via the `i18nKey` — only the logo, brand color, placeholder
 * format, optional fields (access token / conversion label), and docs URL are
 * fixed here.
 */
export const PLATFORMS: Platform[] = [
  {
    id: 'meta',
    i18nKey: 'meta',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.477 2 2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.879V14.89h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.989C18.343 21.129 22 16.99 22 12c0-5.523-4.477-10-10-10z" />
      </svg>
    ),
    color: 'bg-info',
    idPlaceholder: '123456789012345',
    hasAccessToken: true,
    docsUrl: 'https://developers.facebook.com/docs/meta-pixel',
  },
  {
    id: 'tiktok',
    i18nKey: 'tiktok',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-5.2 1.74 2.89 2.89 0 012.31-4.64 2.93 2.93 0 01.88.13V9.4a6.84 6.84 0 00-1-.05A6.33 6.33 0 005 20.1a6.34 6.34 0 0010.86-4.43v-7a8.16 8.16 0 004.77 1.52v-3.4a4.85 4.85 0 01-1-.1z" />
      </svg>
    ),
    color: 'bg-black',
    idPlaceholder: 'CXXXXXXXXXXXXXXXXXX',
    hasAccessToken: true,
    docsUrl: 'https://ads.tiktok.com/help/article?aid=10021',
  },
  {
    id: 'snapchat',
    i18nKey: 'snapchat',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-.809-.33-1.227-.719-1.212-1.168 0-.359.285-.69.735-.838.165-.045.359-.074.523-.074.12 0 .285.015.465.074.36.18.735.301 1.032.301.196 0 .33-.045.406-.089-.009-.18-.024-.359-.03-.539 0-.015-.003-.044-.003-.059-.104-1.627-.225-3.653.299-4.847C7.859 1.07 11.216.793 12.206.793z" />
      </svg>
    ),
    color: 'bg-warning',
    idPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    docsUrl: 'https://businesshelp.snapchat.com/s/article/snap-pixel-about',
  },
  {
    id: 'googleAnalytics',
    i18nKey: 'googleAnalytics',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M22.84 2.9987V20.9987C22.8411 21.5288 22.6317 22.0381 22.2576 22.4131C21.8835 22.7882 21.3747 22.999 20.8446 22.9999H17.0046C16.4754 22.9977 15.968 22.7864 15.595 22.4116C15.222 22.0369 15.013 21.5285 15.0146 20.9993V2.9993C15.0134 2.46945 15.2227 1.96061 15.5969 1.58573C15.971 1.21085 16.4798 1.0001 17.0099 0.999287H20.8499C21.3788 1.00149 21.8857 1.21309 22.258 1.58789C22.6303 1.9627 22.8388 2.47082 22.8379 2.9999L22.84 2.9987Z" />
        <path d="M15.0146 14.9987V20.9987C15.0158 21.5285 14.8065 22.0374 14.4323 22.4122C14.0582 22.7871 13.5494 22.9979 13.0193 22.9987H9.17929C8.64897 22.9987 8.14035 22.7879 7.7653 22.413C7.39025 22.038 7.17929 21.5295 7.17929 20.9993V14.9993C7.17929 14.4691 7.39025 13.9606 7.7653 13.5857C8.14035 13.2108 8.64897 13 9.17929 13H13.0193C13.5495 13.0008 14.0583 13.2117 14.4324 13.5866C14.8066 13.9614 15.0158 14.4703 15.0146 15.0001V14.9987Z" />
        <path d="M7.22 20.9987C7.22 22.1033 6.32457 22.9987 5.22 22.9987C4.11543 22.9987 3.22 22.1033 3.22 20.9987C3.22 19.8941 4.11543 18.9987 5.22 18.9987C6.32457 18.9987 7.22 19.8941 7.22 20.9987Z" />
      </svg>
    ),
    color: 'bg-primary',
    idPlaceholder: 'G-XXXXXXXXXX',
    docsUrl: 'https://developers.google.com/analytics/devguides/collection/ga4',
  },
  {
    id: 'googleTagManager',
    i18nKey: 'googleTagManager',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0L1.608 6v12L12 24l10.392-6V6zm-1.068 17.4l-4.788-4.788 1.932-1.932 2.856 2.856 5.94-5.94 1.932 1.932z" />
      </svg>
    ),
    color: 'bg-info',
    idPlaceholder: 'GTM-XXXXXXX',
    docsUrl: 'https://developers.google.com/tag-manager',
  },
  {
    id: 'googleAds',
    i18nKey: 'googleAds',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3.9987 17.9971L12 3.99707L20.0013 17.9971H3.9987ZM7.46426 16.4971H16.5357L12 8.73242L7.46426 16.4971Z" />
        <path d="M12 21.75C13.2426 21.75 14.25 20.7426 14.25 19.5C14.25 18.2574 13.2426 17.25 12 17.25C10.7574 17.25 9.75 18.2574 9.75 19.5C9.75 20.7426 10.7574 21.75 12 21.75Z" />
      </svg>
    ),
    color: 'bg-success',
    idPlaceholder: 'AW-XXXXXXXXX',
    hasConversionLabel: true,
    docsUrl: 'https://support.google.com/google-ads/answer/6095821',
  },
  {
    id: 'twitter',
    i18nKey: 'twitter',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
    color: 'bg-black',
    idPlaceholder: 'xxxxx',
    docsUrl:
      'https://business.twitter.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites.html',
  },
  {
    id: 'pinterest',
    i18nKey: 'pinterest',
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0C5.373 0 0 5.372 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738.098.119.112.224.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.631-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12 0-6.628-5.373-12-12-12z" />
      </svg>
    ),
    color: 'bg-destructive',
    idPlaceholder: '1234567890123',
    docsUrl: 'https://help.pinterest.com/en/business/article/install-the-pinterest-tag',
  },
];

/**
 * Maps a platform id to the JSON field name used for its main ID value.
 * Most platforms use `pixelId`, but Google / Pinterest use their own.
 */
export function getIdField(platformId: string): string {
  if (platformId === 'googleAnalytics') return 'measurementId';
  if (platformId === 'googleTagManager') return 'containerId';
  if (platformId === 'googleAds') return 'conversionId';
  if (platformId === 'pinterest') return 'tagId';
  return 'pixelId';
}
