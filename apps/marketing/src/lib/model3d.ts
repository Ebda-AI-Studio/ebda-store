import type { Locale } from './site';
import { STORE_HOME, absoluteUrl } from './site';

/** The verticals of the 3D section (Ruling MKT-2). Qamar shows the sneaker, Souq the brass lantern, Lamma its own clay pot (MKT-13), Jasmine a serum bottle and Dahab a solitaire ring (ASSETS-AI-1: procedural models of our own). */
export const MODEL3D_IDS = ['qamar', 'souq', 'lamma', 'jasmine', 'dahab'] as const;
export type Model3dId = (typeof MODEL3D_IDS)[number];

export interface Model3dDef {
  id: Model3dId;
  /** Published path of the optimised GLB (meshopt + WebP, never Draco: R-EBDA-3D-3). */
  glb: string;
  /** glTF KHR_materials_variants names driving the colour swatches (empty: none). */
  variants: { id: string; hex: string }[];
  /**
   * The look whose product-page colours and fonts the phone wears. A mirror of that look's
   * custom properties in public/looks/<template>.html (tests/unit/marketing-model3d.test.ts
   * fails when they drift).
   */
  skin: { look: string; bg: string; ink: string; mut: string; ac: string; fd: string; fb: string };
}

export const MODEL3D: Record<Model3dId, Model3dDef> = {
  qamar: {
    id: 'qamar',
    glb: '/3d/qamar-sneaker.glb',
    variants: [
      { id: 'midnight', hex: '#1c7fae' },
      { id: 'beach', hex: '#e6a7a8' },
      { id: 'street', hex: '#1b1b1d' },
    ],
    skin: {
      look: 'qamar-a',
      bg: '#fff',
      ink: '#141414',
      mut: '#5c5c5c',
      ac: '#6e1f2a',
      fd: 'Noto Naskh Arabic',
      fb: 'IBM Plex Sans Arabic',
    },
  },
  souq: {
    id: 'souq',
    glb: '/3d/brass-diya-lantern.glb',
    variants: [],
    skin: {
      look: 'souq-b',
      bg: '#0f3b2e',
      ink: '#f6f3ea',
      mut: '#a9c4b6',
      ac: '#c89b3c',
      fd: 'Changa',
      fb: 'Cairo',
    },
  },
  lamma: {
    id: 'lamma',
    glb: '/3d/lamma-clay-pot.glb',
    variants: [],
    skin: {
      look: 'lamma-a',
      bg: '#fff',
      ink: '#2a1a14',
      mut: '#6b5a52',
      ac: '#3e7a3a',
      fd: 'El Messiri',
      fb: 'Cairo',
    },
  },
  jasmine: {
    id: 'jasmine',
    glb: '/3d/jasmine-serum.glb',
    variants: [
      { id: 'rose', hex: '#de8f95' },
      { id: 'amber', hex: '#d18b1f' },
      { id: 'sage', hex: '#7fa383' },
    ],
    skin: {
      look: 'jasmine-a',
      bg: '#2e2a22',
      ink: '#f3efe6',
      mut: '#cfc7b6',
      ac: '#c9822b',
      fd: 'Amiri',
      fb: 'Noto Sans Arabic',
    },
  },
  dahab: {
    id: 'dahab',
    glb: '/3d/dahab-solitaire.glb',
    variants: [
      { id: 'yellow-gold', hex: '#e0b552' },
      { id: 'rose-gold', hex: '#e8a68e' },
      { id: 'white-gold', hex: '#ecedef' },
    ],
    skin: {
      look: 'dahab-a',
      bg: '#fff',
      ink: '#121212',
      mut: '#5A5A5A',
      ac: '#9a6e2a',
      fd: 'Reem Kufi',
      fb: 'IBM Plex Sans Arabic',
    },
  },
};

/**
 * Still image (no extension) shown before the model loads and instead of it for reduced motion,
 * Save-Data and no WebGL: one per sneaker, serum and ring colourway, one for the lantern, one for the clay pot.
 */
export function stillBase(id: Model3dId, variant: string | null): string {
  if (id === 'qamar') return `/3d/stills/qamar-${variant ?? 'midnight'}`;
  if (id === 'jasmine') return `/3d/stills/jasmine-${variant ?? 'rose'}`;
  if (id === 'dahab') return `/3d/stills/dahab-${variant ?? 'yellow-gold'}`;
  return id === 'lamma' ? '/3d/stills/clay-pot' : '/3d/stills/lantern';
}

/** Where a phone lands after scanning the desktop QR: this page, this vertical, this section. */
export function arPageUrl(locale: Locale, id: Model3dId): string {
  return `${absoluteUrl(STORE_HOME[locale])}?m=${id}#model3d`;
}

/** Published path of the build-time QR image for a vertical + locale (scripts/3d/make-qr.ts). */
export function qrPath(locale: Locale, id: Model3dId): string {
  return `/3d/qr/${id}-${locale}.svg`;
}
