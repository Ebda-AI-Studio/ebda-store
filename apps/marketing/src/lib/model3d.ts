import type { Locale } from './site';
import { HOME, absoluteUrl } from './site';

/** The three verticals of the 3D section (Ruling MKT-2). Qamar shows the sneaker, Souq the brass lantern, Lamma its own clay pot (MKT-13). */
export const MODEL3D_IDS = ['qamar', 'souq', 'lamma'] as const;
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
      bg: '#FFFFFF',
      ink: '#141414',
      mut: '#5C5C5C',
      ac: '#6F1F2A',
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
      bg: '#103C2E',
      ink: '#F6F3EA',
      mut: '#B3CCBF',
      ac: '#C89C3C',
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
      bg: '#FFFFFF',
      ink: '#2D1B20',
      mut: '#62505A',
      ac: '#2F6A34',
      fd: 'El Messiri',
      fb: 'Cairo',
    },
  },
};

/**
 * Still image (no extension) shown before the model loads and instead of it for reduced motion,
 * Save-Data and no WebGL: one per sneaker colourway, one for the lantern, one for the clay pot.
 */
export function stillBase(id: Model3dId, variant: string | null): string {
  if (id === 'qamar') return `/3d/stills/qamar-${variant ?? 'midnight'}`;
  return id === 'lamma' ? '/3d/stills/clay-pot' : '/3d/stills/lantern';
}

/** Where a phone lands after scanning the desktop QR: this page, this vertical, this section. */
export function arPageUrl(locale: Locale, id: Model3dId): string {
  return `${absoluteUrl(HOME[locale])}?m=${id}#model3d`;
}

/** Published path of the build-time QR image for a vertical + locale (scripts/3d/make-qr.ts). */
export function qrPath(locale: Locale, id: Model3dId): string {
  return `/3d/qr/${id}-${locale}.svg`;
}
