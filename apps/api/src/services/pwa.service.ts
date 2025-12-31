import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

// PWA Settings structure
interface PWASettings {
  // App Identity
  appName: string;
  appNameAr?: string;
  shortName: string;
  shortNameAr?: string;
  description: string;
  descriptionAr?: string;

  // Theme
  themeColor: string;
  backgroundColor: string;

  // Icons
  icon192?: string;
  icon512?: string;
  maskableIcon?: string;

  // Display
  display: 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser';
  orientation: 'any' | 'portrait' | 'landscape';
  startUrl: string;

  // Features
  installPromptEnabled: boolean;
  offlineEnabled: boolean;
  pushNotificationsEnabled: boolean;

  // iOS Specific
  iosStatusBarStyle: 'default' | 'black' | 'black-translucent';
  splashScreenColor: string;
}

const DEFAULT_PWA_SETTINGS: PWASettings = {
  appName: '',
  shortName: '',
  description: '',
  themeColor: '#f97316', // Orange 500
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

interface PWASettingsResponse {
  pwaEnabled: boolean;
  settings: PWASettings;
}

export class PWAService {
  /**
   * Get store PWA settings
   */
  static async getSettings(storeId: string): Promise<PWASettingsResponse> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        name: true,
        pwaEnabled: true,
        pwaSettings: true,
      },
    });

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    const storedSettings = (store.pwaSettings as Partial<PWASettings>) || {};
    const settings: PWASettings = {
      ...DEFAULT_PWA_SETTINGS,
      ...storedSettings,
      // Use store name as default if not set
      appName: storedSettings.appName || store.name,
      shortName: storedSettings.shortName || store.name.substring(0, 12),
      description: storedSettings.description || `Shop at ${store.name}`,
    };

    return {
      pwaEnabled: store.pwaEnabled,
      settings,
    };
  }

  /**
   * Update store PWA settings
   */
  static async updateSettings(
    storeId: string,
    data: { pwaEnabled?: boolean; settings?: Partial<PWASettings> }
  ): Promise<PWASettingsResponse> {
    // Verify store exists
    const existing = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, pwaSettings: true },
    });

    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    const currentSettings = {
      ...DEFAULT_PWA_SETTINGS,
      appName: existing.name,
      shortName: existing.name.substring(0, 12),
      description: `Shop at ${existing.name}`,
      ...(existing.pwaSettings as Partial<PWASettings>),
    };

    const updatedSettings = data.settings
      ? { ...currentSettings, ...data.settings }
      : currentSettings;

    const store = await prisma.store.update({
      where: { id: storeId },
      data: {
        pwaEnabled: data.pwaEnabled,
        pwaSettings: updatedSettings as unknown as Prisma.InputJsonValue,
      },
      select: {
        pwaEnabled: true,
        pwaSettings: true,
      },
    });

    return {
      pwaEnabled: store.pwaEnabled,
      settings: store.pwaSettings as unknown as PWASettings,
    };
  }

  /**
   * Generate PWA manifest JSON
   */
  static async generateManifest(storeId: string): Promise<object | null> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        name: true,
        pwaEnabled: true,
        pwaSettings: true,
      },
    });

    if (!store || !store.pwaEnabled) {
      return null;
    }

    const settings = {
      ...DEFAULT_PWA_SETTINGS,
      appName: store.name,
      shortName: store.name.substring(0, 12),
      description: `Shop at ${store.name}`,
      ...(store.pwaSettings as Partial<PWASettings>),
    };

    const manifest: Record<string, unknown> = {
      name: settings.appName,
      short_name: settings.shortName,
      description: settings.description,
      theme_color: settings.themeColor,
      background_color: settings.backgroundColor,
      display: settings.display,
      orientation: settings.orientation,
      start_url: settings.startUrl,
      scope: '/',
      icons: [],
    };

    // Add icons if available
    const icons: Array<{ src: string; sizes: string; type: string; purpose?: string }> = [];

    if (settings.icon192) {
      icons.push({
        src: settings.icon192,
        sizes: '192x192',
        type: 'image/png',
      });
    }

    if (settings.icon512) {
      icons.push({
        src: settings.icon512,
        sizes: '512x512',
        type: 'image/png',
      });
    }

    if (settings.maskableIcon) {
      icons.push({
        src: settings.maskableIcon,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      });
    }

    // Default icons if none provided
    if (icons.length === 0) {
      icons.push(
        {
          src: '/icons/icon-192x192.png',
          sizes: '192x192',
          type: 'image/png',
        },
        {
          src: '/icons/icon-512x512.png',
          sizes: '512x512',
          type: 'image/png',
        }
      );
    }

    manifest.icons = icons;

    return manifest;
  }

  /**
   * Generate service worker configuration
   */
  static async getServiceWorkerConfig(storeId: string): Promise<{
    enabled: boolean;
    offlineEnabled: boolean;
    pushEnabled: boolean;
  }> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        pwaEnabled: true,
        pwaSettings: true,
      },
    });

    if (!store || !store.pwaEnabled) {
      return {
        enabled: false,
        offlineEnabled: false,
        pushEnabled: false,
      };
    }

    const settings = (store.pwaSettings as Partial<PWASettings>) || {};

    return {
      enabled: true,
      offlineEnabled: settings.offlineEnabled ?? true,
      pushEnabled: settings.pushNotificationsEnabled ?? false,
    };
  }

  /**
   * Get iOS meta tags configuration
   */
  static async getIOSConfig(storeId: string): Promise<{
    enabled: boolean;
    statusBarStyle: string;
    splashColor: string;
    title: string;
  } | null> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        name: true,
        pwaEnabled: true,
        pwaSettings: true,
      },
    });

    if (!store || !store.pwaEnabled) {
      return null;
    }

    const settings = {
      ...DEFAULT_PWA_SETTINGS,
      ...(store.pwaSettings as Partial<PWASettings>),
    };

    return {
      enabled: true,
      statusBarStyle: settings.iosStatusBarStyle,
      splashColor: settings.splashScreenColor,
      title: settings.appName || store.name,
    };
  }
}
