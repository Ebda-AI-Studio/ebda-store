'use client';

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { StoreTheme, TemplateId } from '@ebda/shared';
import { DEFAULT_THEME, getTemplateTheme, themeToCssVars } from '@ebda/shared';

/**
 * Theme context value
 */
export interface ThemeContextValue {
  /** Current theme configuration */
  theme: StoreTheme;
  /** Current template ID */
  templateId: TemplateId;
  /** Whether RTL mode is enabled */
  isRtl: boolean;
  /** CSS variables derived from theme */
  cssVars: Record<string, string>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Hook to access theme context
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

/**
 * Hook to access theme with safe fallback (no error thrown)
 */
export function useThemeSafe(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    return {
      theme: DEFAULT_THEME,
      templateId: 'modern',
      isRtl: false,
      cssVars: themeToCssVars(DEFAULT_THEME),
    };
  }
  return context;
}

export interface ThemeProviderProps {
  children: ReactNode;
  /** Store theme configuration (overrides template defaults) */
  theme?: Partial<StoreTheme>;
  /** Template ID to use for base theme */
  templateId?: TemplateId;
  /** Enable RTL mode */
  isRtl?: boolean;
  /** Apply theme to document root (for server/client coordination) */
  applyToDocument?: boolean;
}

/**
 * ThemeProvider applies store theme to the app.
 *
 * Usage:
 * ```tsx
 * <ThemeProvider
 *   templateId="modern"
 *   theme={{ primaryColor: '26 100% 50%' }}
 *   isRtl={false}
 * >
 *   <App />
 * </ThemeProvider>
 * ```
 */
export function ThemeProvider({
  children,
  theme: themeOverrides,
  templateId = 'modern',
  isRtl = false,
  applyToDocument = true,
}: ThemeProviderProps) {
  // Merge template theme with store overrides
  const theme = useMemo<StoreTheme>(() => {
    const baseTheme = getTemplateTheme(templateId);
    return {
      ...baseTheme,
      ...themeOverrides,
    };
  }, [templateId, themeOverrides]);

  // Generate CSS variables
  const cssVars = useMemo(() => themeToCssVars(theme), [theme]);

  // Apply theme to document root
  useEffect(() => {
    if (!applyToDocument || typeof document === 'undefined') return;

    const root = document.documentElement;

    // Apply all CSS variables
    Object.entries(cssVars).forEach(([key, value]) => {
      root.style.setProperty(key, value);
    });

    // Apply RTL
    root.dir = isRtl ? 'rtl' : 'ltr';
    root.lang = isRtl ? 'ar' : 'en';

    // Apply custom CSS if provided (sanitized to prevent injection)
    if (theme.customCss) {
      const styleId = 'force-theme-custom';
      let styleEl = document.getElementById(styleId) as HTMLStyleElement;
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        document.head.appendChild(styleEl);
      }
      // Sanitize CSS: strip dangerous patterns like expressions, imports, urls with javascript:
      const sanitizedCss = theme.customCss
        .replace(/expression\s*\(/gi, '')
        .replace(/@import\b/gi, '')
        .replace(/javascript\s*:/gi, '')
        .replace(/behavior\s*:/gi, '')
        .replace(/-moz-binding\s*:/gi, '')
        .replace(/url\s*\(\s*['"]?\s*javascript:/gi, 'url(')
        .replace(/<\/?script[^>]*>/gi, '')
        .replace(/<\/?style[^>]*>/gi, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      styleEl.textContent = sanitizedCss;
    }

    // Cleanup
    return () => {
      // Only cleanup custom CSS, leave other vars for next theme
      const customStyle = document.getElementById('force-theme-custom');
      if (customStyle) {
        customStyle.remove();
      }
    };
  }, [cssVars, isRtl, theme.customCss, applyToDocument]);

  const contextValue = useMemo<ThemeContextValue>(
    () => ({
      theme,
      templateId,
      isRtl,
      cssVars,
    }),
    [theme, templateId, isRtl, cssVars]
  );

  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>;
}

/**
 * Generate inline style props for theme application
 * Useful for SSR where document.documentElement is not available
 */
export function getThemeStyleProps(theme: StoreTheme): React.CSSProperties {
  const vars = themeToCssVars(theme);
  const style: Record<string, string> = {};

  Object.entries(vars).forEach(([key, value]) => {
    style[key] = value;
  });

  return style as React.CSSProperties;
}
