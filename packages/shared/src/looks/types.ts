import type { StoreTheme, TemplateId, BorderRadius } from '../types/store-theme';

export type LookTemplate = 'qamar' | 'souq' | 'jasmine' | 'lamma' | 'dahab';
export type LookId = `${LookTemplate}.${string}`;
export type Density = 'compact' | 'regular' | 'airy';
export type ImageRatio = '1/1' | '4/5' | '3/4' | '4/3';
export type Motion = 'none' | 'subtle' | 'expressive';

/** Colour roles as hex; converted to HSL triplets by lookTheme(). */
export interface LookTokens {
  page: string;
  surface: string;
  ink: string;
  muted: string;
  primary: string;
  onPrimary: string;
  accent: string;
  line: string;
  /** Arabic display face, body face (Arabic-capable), Latin display face — Google Fonts family names. */
  fonts: { display: string; body: string; latin: string };
  radius: BorderRadius;
  density: Density;
  imageRatio: ImageRatio;
  motion: Motion;
}

export interface LookDefinition {
  id: LookId;
  template: LookTemplate;
  letter: 'A' | 'B' | 'C';
  name: { ar: string; en: string };
  forWhom: { ar: string; en: string };
  idea: { ar: string; en: string };
  tokens: LookTokens;
  /** Component skin used to render until the template's own skin ships (Ruling LOOKS-5). */
  skin: TemplateId;
  /** 'designed' = tokens + mix only; 'built' = skin + sections shipped and reviewed (demo bar lists only built). */
  status: 'designed' | 'built';
}

/** StoreTheme keys a look owns. A stored value for one of these is a merchant override. */
export const LOOK_TOKEN_KEYS = [
  'backgroundColor',
  'foregroundColor',
  'cardColor',
  'cardForeground',
  'popoverColor',
  'popoverForeground',
  'mutedColor',
  'mutedForeground',
  'primaryColor',
  'primaryForeground',
  'accentColor',
  'accentForeground',
  'secondaryColor',
  'secondaryForeground',
  'borderColor',
  'inputColor',
  'ringColor',
  'headingFont',
  'bodyFont',
  'borderRadius',
  'bgPage',
  'bgSectionAlt',
  'density',
  'imageRatio',
  'motion',
] as const satisfies readonly (keyof StoreTheme)[];
