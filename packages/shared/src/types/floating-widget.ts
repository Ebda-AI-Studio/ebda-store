/**
 * Floating Widget — storefront sticky action button group. Step 2 of
 * the engagement-features rollout 2026-05-21.
 *
 * Renders a fixed-positioned button in the corner of the viewport that
 * collapses to a single circle and expands to a stack of merchant-
 * chosen action buttons (WhatsApp, Instagram, phone, email, background
 * music, custom link). Toggled per-store via the `floating_widget`
 * feature flag in FEATURE_REGISTRY; config lives on
 * `Store.settings.floatingWidget`.
 */

export type FloatingButtonKind = 'whatsapp' | 'instagram' | 'phone' | 'email' | 'music' | 'custom';

export type FloatingPosition = 'br' | 'bl' | 'tr' | 'tl';
export type FloatingExpandDirection = 'up' | 'down' | 'left' | 'right';

/**
 * One button inside the floating widget. The merchant configures these
 * from the admin /floating-widget page. Each button kind has its own
 * config shape — they ALL live on the same type for simplicity; the
 * UI shows only the fields relevant to the picked kind.
 */
export interface FloatingButton {
  /** Stable client-side id for drag-reorder + React keys. */
  id: string;
  kind: FloatingButtonKind;
  /** Tooltip / aria-label shown on the storefront. */
  label?: string;
  labelAr?: string;
  /** Solid background color (hex or token:<name>). Defaults per kind. */
  bgColor?: string;
  /** Icon color override (hex or token:<name>). Defaults to readable foreground. */
  iconColor?: string;
  /** Optional override of the default kind icon — a public URL to an
   *  R2-hosted PNG/SVG. Mostly used by `kind: 'custom'`. */
  iconUrl?: string;
  /** kind=whatsapp: full phone in international format, no spaces or +
   *  (e.g. "96522668490"). Opens https://wa.me/<phone>?text=<label>.  */
  whatsappPhone?: string;
  /** kind=whatsapp: optional prefilled message text. */
  whatsappMessage?: string;
  /** kind=instagram: Instagram handle without the @ (e.g. "wadyaljuz"). */
  instagramHandle?: string;
  /** kind=phone: full phone in international format. Opens tel: link. */
  phoneNumber?: string;
  /** kind=email: email address. Opens mailto: link. */
  emailAddress?: string;
  /** kind=email: optional default subject. */
  emailSubject?: string;
  /** kind=music: public URL to an R2-hosted audio file (mp3, ogg, m4a).
   *  Click toggles play/pause. Auto-pauses on tab blur. */
  musicUrl?: string;
  /** kind=music: when true, audio loops indefinitely (background music
   *  pattern). When false, plays once. Default true. */
  musicLoop?: boolean;
  /** kind=custom: target URL. Opens in new tab. */
  customHref?: string;
}

export interface FloatingWidgetConfig {
  /** Master enable. When false (or the whole object is undefined), the
   *  storefront renders nothing. Distinct from the feature flag — even
   *  with `floating_widget` enabled by super-admin, the merchant still
   *  has to flip this on. */
  enabled?: boolean;
  /** Viewport corner. Defaults to 'br' (bottom-right). */
  position?: FloatingPosition;
  /** Direction the expanded buttons fan out from the collapse-toggle.
   *  Defaults to 'up' for bottom positions, 'down' for top positions. */
  expandDirection?: FloatingExpandDirection;
  /** Collapse-toggle bg color (the always-visible circle). Defaults to
   *  the store's primary token. */
  toggleBgColor?: string;
  /** Optional URL to an icon for the collapse-toggle. Defaults to a
   *  hamburger / message-circle SVG built into the component. */
  toggleIconUrl?: string;
  /** Tooltip on the collapse-toggle. Bilingual. */
  toggleLabel?: string;
  toggleLabelAr?: string;
  /** When true, the widget starts EXPANDED on every page load (vs
   *  starting collapsed and requiring a tap to expand). Defaults false
   *  — most merchants want a single visible circle to avoid clutter. */
  startExpanded?: boolean;
  /** Hide on mobile / desktop. Defaults to showing on both. */
  hideOnMobile?: boolean;
  hideOnDesktop?: boolean;
  /** Ordered list of buttons. UI renders in this order; merchant drags
   *  to reorder. Empty array = nothing to expand to (just the toggle). */
  buttons?: FloatingButton[];
}

export const DEFAULT_FLOATING_WIDGET_CONFIG: FloatingWidgetConfig = {
  enabled: false,
  position: 'br',
  expandDirection: 'up',
  startExpanded: false,
  buttons: [],
};
