export interface PWASettings {
  appName: string;
  appNameAr?: string;
  shortName: string;
  shortNameAr?: string;
  description: string;
  descriptionAr?: string;
  themeColor: string;
  backgroundColor: string;
  icon192?: string;
  icon512?: string;
  maskableIcon?: string;
  display: 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser';
  orientation: 'any' | 'portrait' | 'landscape';
  startUrl: string;
  installPromptEnabled: boolean;
  offlineEnabled: boolean;
  pushNotificationsEnabled: boolean;
  iosStatusBarStyle: 'default' | 'black' | 'black-translucent';
  splashScreenColor: string;
}

export interface StoreInfo {
  name: string;
  nameAr?: string;
  logo?: string;
  logoAr?: string;
  favicon?: string;
  description?: string;
  descriptionAr?: string;
  theme?: {
    primaryColor?: string;
    secondaryColor?: string;
  };
}

export type StatusMessage = { type: 'success' | 'error'; text: string };

export const DEFAULT_SETTINGS: PWASettings = {
  appName: '',
  shortName: '',
  description: '',
  themeColor: '#f97316',
  backgroundColor: '#ffffff',
  display: 'standalone',
  orientation: 'any',
  startUrl: '/',
  installPromptEnabled: true,
  offlineEnabled: true,
  pushNotificationsEnabled: false,
  iosStatusBarStyle: 'default',
  splashScreenColor: '#ffffff',
};

export const DISPLAY_OPTIONS: Array<{ value: PWASettings['display']; key: string }> = [
  { value: 'standalone', key: 'standalone' },
  { value: 'fullscreen', key: 'fullscreen' },
  { value: 'minimal-ui', key: 'minimalUi' },
  { value: 'browser', key: 'browser' },
];

export const ORIENTATION_OPTIONS: Array<{ value: PWASettings['orientation']; key: string }> = [
  { value: 'any', key: 'any' },
  { value: 'portrait', key: 'portrait' },
  { value: 'landscape', key: 'landscape' },
];

export const IOS_STATUS_OPTIONS: Array<{ value: PWASettings['iosStatusBarStyle']; key: string }> = [
  { value: 'default', key: 'default' },
  { value: 'black', key: 'black' },
  { value: 'black-translucent', key: 'blackTranslucent' },
];
