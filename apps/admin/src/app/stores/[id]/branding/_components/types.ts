export interface StoreTheme {
  primaryColor: string;
  primaryForeground: string;
  secondaryColor: string;
  backgroundColor: string;
  foregroundColor: string;
  fontFamily: string;
  borderRadius: string;
}

export interface StoreBranding {
  id: string;
  name: string;
  nameAr?: string;
  logo?: string;
  logoAr?: string;
  favicon?: string;
  description?: string;
  descriptionAr?: string;
  theme: StoreTheme;
  email?: string;
  phone?: string;
  phoneAr?: string;
  whatsapp?: string;
  address?: string;
  addressAr?: string;
  socialLinks: {
    instagram?: string;
    facebook?: string;
    twitter?: string;
    tiktok?: string;
    youtube?: string;
    snapchat?: string;
  };
}

export type BrandingTabId = 'branding' | 'theme' | 'contact' | 'social';

export const DEFAULT_THEME: StoreTheme = {
  primaryColor: '26 100% 50%',
  primaryForeground: '0 0% 100%',
  secondaryColor: '220 14% 96%',
  backgroundColor: '0 0% 100%',
  foregroundColor: '224 71% 4%',
  fontFamily: 'default',
  borderRadius: 'md',
};

export const FONT_OPTIONS: Array<{ value: string; key: string }> = [
  { value: 'default', key: 'default' },
  { value: 'serif', key: 'serif' },
  { value: 'modern', key: 'modern' },
  { value: 'rounded', key: 'rounded' },
];

export const BORDER_RADIUS_OPTIONS: Array<{ value: string; key: string }> = [
  { value: 'none', key: 'none' },
  { value: 'sm', key: 'sm' },
  { value: 'md', key: 'md' },
  { value: 'lg', key: 'lg' },
  { value: 'xl', key: 'xl' },
];

export const COLOR_PRESETS: Array<{ key: string; hex: string }> = [
  { key: 'orange', hex: '#FF6600' },
  { key: 'blue', hex: '#3B82F6' },
  { key: 'green', hex: '#16A34A' },
  { key: 'purple', hex: '#7C3AED' },
  { key: 'rose', hex: '#E11D48' },
  { key: 'teal', hex: '#0D9488' },
  { key: 'amber', hex: '#F59E0B' },
  { key: 'black', hex: '#171717' },
];

export const SOCIAL_PLATFORMS: Array<{
  key: 'instagram' | 'facebook' | 'twitter' | 'tiktok' | 'youtube' | 'snapchat';
  labelKey: string;
  placeholder: string;
}> = [
  { key: 'instagram', labelKey: 'instagram', placeholder: 'https://instagram.com/yourstore' },
  { key: 'facebook', labelKey: 'facebook', placeholder: 'https://facebook.com/yourstore' },
  { key: 'twitter', labelKey: 'twitter', placeholder: 'https://twitter.com/yourstore' },
  { key: 'tiktok', labelKey: 'tiktok', placeholder: 'https://tiktok.com/@yourstore' },
  { key: 'youtube', labelKey: 'youtube', placeholder: 'https://youtube.com/@yourstore' },
  { key: 'snapchat', labelKey: 'snapchat', placeholder: 'https://snapchat.com/add/yourstore' },
];
