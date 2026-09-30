import type { ProductCardDefaults, StoreLayoutSettings } from '@force/shared';
import type { CtaShape, CtaSize } from './card-size';

/**
 * Resolve the merchant-configurable product-card defaults once.
 *
 * The same sixteen-line `defaults?.x` block existed in SIX card components —
 * bold, classic, elegant, minimal, modern and the canonical PecannbeeProductCard
 * — identical apart from two comments and one place that wrote
 * `layout?.productCardDefaults?.productNameCase` instead of
 * `defaults?.productNameCase` (the same expression, since `defaults` IS
 * `layout?.productCardDefaults`).
 *
 * Six copies of the merchant's card settings means adding one setting requires
 * six edits, and the template that gets missed silently ignores what the
 * merchant configured — a difference they see on their storefront and we do not.
 */
export interface ResolvedProductCardDefaults {
  ctaShape?: CtaShape;
  ctaSize?: CtaSize;
  ctaColor?: ProductCardDefaults['ctaColor'];
  ctaTextColor?: ProductCardDefaults['ctaTextColor'];
  ctaLabelTextEn?: ProductCardDefaults['ctaLabelTextEn'];
  ctaLabelTextAr?: ProductCardDefaults['ctaLabelTextAr'];
  oosDimColor?: ProductCardDefaults['oosDimColor'];
  oosLabel?: ProductCardDefaults['oosLabel'];
  oosLabelTextEn?: ProductCardDefaults['oosLabelTextEn'];
  oosLabelTextAr?: ProductCardDefaults['oosLabelTextAr'];
  oosLabelShape?: CtaShape;
  // Derived from the source type, never hand-widened: writing this as `string`
  // silently dropped the 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end'
  // union and broke every card that passes it on.
  oosLabelPlacement?: ProductCardDefaults['oosLabelPlacement'];
  oosLabelColor?: ProductCardDefaults['oosLabelColor'];
  oosLabelTextColor?: ProductCardDefaults['oosLabelTextColor'];
  /** Merchant-controlled name casing; unset = normal, no forced caps. */
  nameCase?: ProductCardDefaults['productNameCase'];
  /** `ctaMode: 'viewOnly'` forces the View link even for in-stock simple products. */
  viewOnly: boolean;
}

export function resolveProductCardDefaults(
  layout?: StoreLayoutSettings | null
): ResolvedProductCardDefaults {
  const defaults = layout?.productCardDefaults;
  return {
    ctaShape: defaults?.ctaShape as CtaShape | undefined,
    ctaSize: defaults?.ctaSize as CtaSize | undefined,
    ctaColor: defaults?.ctaColor,
    ctaTextColor: defaults?.ctaTextColor,
    ctaLabelTextEn: defaults?.ctaLabelTextEn,
    ctaLabelTextAr: defaults?.ctaLabelTextAr,
    oosDimColor: defaults?.oosDimColor,
    oosLabel: defaults?.oosLabel,
    oosLabelTextEn: defaults?.oosLabelTextEn,
    oosLabelTextAr: defaults?.oosLabelTextAr,
    oosLabelShape: defaults?.oosLabelShape as CtaShape | undefined,
    oosLabelPlacement: defaults?.oosLabelPlacement,
    oosLabelColor: defaults?.oosLabelColor,
    oosLabelTextColor: defaults?.oosLabelTextColor,
    nameCase: defaults?.productNameCase,
    viewOnly: defaults?.ctaMode === 'viewOnly',
  };
}

/**
 * `resolveProductCardDefaults` output, pre-renamed to the `resolved*` names
 * every CTA/OOS card render path needs (the local scope in each of those
 * components already has its own `ctaShape`/`ctaSize`/etc. from other props,
 * so the fields must not collide). Before this, ProductListItem.tsx,
 * elegant/ProductCard.tsx and ProductCarousel.tsx each repeated the identical
 * ~15-line `const { ctaShape: resolvedCtaShape, ... } = resolveProductCardDefaults(layout)`
 * destructure — dream #1095. One rename here, one call site each there.
 *
 * Issue #2093 — this type and its mapping are DERIVED from
 * `ResolvedProductCardDefaults`, never re-declared field by field. A
 * hand-written copy let a new field added to the base resolver silently never
 * reach any of the eight render paths (they all call only this wrapper) — the
 * exact "template that gets missed" failure the base resolver exists to
 * prevent. Now a new base field appears here automatically, renamed.
 */
type UnrenamedKey = 'nameCase' | 'viewOnly';
type RenamedKey<K extends string> = K extends UnrenamedKey ? K : `resolved${Capitalize<K>}`;

export type ResolvedProductCardCtaOosDefaults = {
  [K in keyof ResolvedProductCardDefaults as RenamedKey<
    K & string
  >]: ResolvedProductCardDefaults[K];
};

const UNRENAMED_KEYS: readonly string[] = ['nameCase', 'viewOnly'] satisfies UnrenamedKey[];

/** The runtime twin of `RenamedKey` — exported for the parity test. */
export function renamedCardDefaultsKey(key: string): string {
  return UNRENAMED_KEYS.includes(key) ? key : `resolved${key[0].toUpperCase()}${key.slice(1)}`;
}

export function resolveProductCardCtaOosDefaults(
  layout?: StoreLayoutSettings | null
): ResolvedProductCardCtaOosDefaults {
  const r = resolveProductCardDefaults(layout);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(r)) out[renamedCardDefaultsKey(key)] = value;
  return out as ResolvedProductCardCtaOosDefaults;
}
