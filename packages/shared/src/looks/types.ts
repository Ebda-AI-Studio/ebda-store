import type { StoreTheme, TemplateId, BorderRadius } from '../types/store-theme';

export type LookTemplate = 'qamar' | 'souq' | 'jasmine' | 'lamma' | 'dahab';
export type LookId = `${LookTemplate}.${string}`;
/** The allowed values of the look-only theme keys (also the theme PUT's allow-lists). */
export const LOOK_DENSITIES = ['compact', 'regular', 'airy'] as const;
export const LOOK_IMAGE_RATIOS = ['1/1', '4/5', '3/4', '4/3'] as const;
export const LOOK_MOTIONS = ['none', 'subtle', 'expressive'] as const;
export type Density = (typeof LOOK_DENSITIES)[number];
export type ImageRatio = (typeof LOOK_IMAGE_RATIOS)[number];
export type Motion = (typeof LOOK_MOTIONS)[number];

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
  /** The look's home section mix, in page order (Ruling B1-3). Absent = the template family's mix. */
  sections?: readonly LookSectionSpec[];
  /** Chrome choices the look's skin reads (Ruling B1-4). */
  chrome?: LookChrome;
}

/** One section of a look's home mix (Ruling B1-3). */
export interface LookSectionSpec {
  /** A SECTION_REGISTRY type with group 'template'. */
  type: string;
  /** Design keys (LOOK_DESIGN_KEYS only), applied to an existing section too. */
  design?: Record<string, unknown>;
  /** Starting settings for a section the store does not have yet (never applied to an existing one). */
  preset?: Record<string, unknown>;
}

/** Chrome choices a skin reads from the look (Ruling B1-4). */
export interface LookChrome {
  header: { logoPlacement: 'start' | 'centre' };
}

/** Settings a look's `design` may set: layout/variant/background/spacing, never content. */
export const LOOK_DESIGN_KEYS = [
  'presentation',
  'mode',
  'layout',
  'layoutMobile',
  'captionPosition',
  'desktopColumns',
  'mobileColumns',
  'columns',
  'tileShape',
  'imagePosition',
  'imageAspect',
  'cardShape',
  'cardAspect',
  'cardGap',
  'showCardFrame',
  'bgColor',
  'paddingTop',
  'paddingBottom',
] as const;

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
