// Theme System
export * from './ThemeProvider';

// Re-export theme types and utilities from shared
export {
  type StoreTheme,
  type TemplateId,
  type FontFamily,
  type BorderRadius,
  type StoreSocialLinks,
  type AnnouncementBar,
  type TemplateInfo,
  DEFAULT_THEME,
  TEMPLATE_THEMES,
  TEMPLATES,
  BORDER_RADIUS_MAP,
  FONT_FAMILY_MAP,
  getTemplateInfo,
  getTemplateTheme,
  themeToCssVars,
  themeToCssString,
  applyThemeToDocument,
  themeToStyleObject,
} from '@force/shared';
