---
name: Pecan & Honey Luxury Aesthetic
colors:
  surface: '#fff8f6'
  surface-dim: '#e4d8d3'
  surface-bright: '#fff8f6'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#fef1ec'
  surface-container: '#f8ebe7'
  surface-container-high: '#f2e6e1'
  surface-container-highest: '#ece0db'
  on-surface: '#201a18'
  on-surface-variant: '#52443d'
  inverse-surface: '#362f2c'
  inverse-on-surface: '#fbeee9'
  outline: '#85736c'
  outline-variant: '#d7c2ba'
  surface-tint: '#885034'
  primary: '#67351b'
  on-primary: '#ffffff'
  primary-container: '#834c30'
  on-primary-container: '#ffc5ab'
  inverse-primary: '#ffb693'
  secondary: '#7c5543'
  on-secondary: '#ffffff'
  secondary-container: '#ffccb5'
  on-secondary-container: '#7b5442'
  tertiary: '#004b4a'
  on-tertiary: '#ffffff'
  tertiary-container: '#196463'
  on-tertiary-container: '#9adedc'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdbcc'
  primary-fixed-dim: '#ffb693'
  on-primary-fixed: '#351000'
  on-primary-fixed-variant: '#6c391f'
  secondary-fixed: '#ffdbcb'
  secondary-fixed-dim: '#eebca5'
  on-secondary-fixed: '#2f1406'
  on-secondary-fixed-variant: '#613e2d'
  tertiary-fixed: '#aaefed'
  tertiary-fixed-dim: '#8fd2d1'
  on-tertiary-fixed: '#00201f'
  on-tertiary-fixed-variant: '#00504f'
  background: '#fff8f6'
  on-background: '#201a18'
  surface-variant: '#ece0db'
typography:
  display-lg:
    fontFamily: IBM Plex Sans
    fontSize: 48px
    fontWeight: '600'
    lineHeight: 56px
    letterSpacing: -0.02em
  display-lg-mobile:
    fontFamily: IBM Plex Sans
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: IBM Plex Sans
    fontSize: 24px
    fontWeight: '500'
    lineHeight: 32px
  headline-sm:
    fontFamily: IBM Plex Sans
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 28px
  body-lg:
    fontFamily: IBM Plex Sans
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: IBM Plex Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: IBM Plex Sans
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.05em
  label-sm:
    fontFamily: IBM Plex Sans
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  xxl: 64px
  container-max: 1200px
  gutter: 24px
  margin-mobile: 16px
---

## Brand & Style

The brand personality is rooted in high-end Middle Eastern hospitality, blending the artisanal warmth of a boutique chocolatier with the disciplined elegance of a luxury fragrance house. The target audience is discerning, valuing quality over quantity and appreciating the "hand-crafted" narrative of gourmet pecans and dates.

The design style is **Corporate Modern with a Tactile twist**. It prioritizes extreme clarity and generous whitespace to evoke a sense of calm and exclusivity. By utilizing a "Soft Luxury" approach, the interface feels approachable yet undeniably premium, using subtle depth and a refined color palette to guide the user through a curated culinary journey.

## Colors

The palette is inspired by the organic textures of the product line. **Warm Pecan Brown** serves as the primary brand anchor, used for key actions and brand moments. **Deep Espresso** provides necessary contrast for secondary elements and depth in typography.

The **Warm Ivory** background is essential; it prevents the interface from feeling "stark" or clinical, providing a parchment-like quality that feels expensive. **Soft Warm-Gold** is reserved strictly for highlights, badges of quality, or interactive states to maintain its perceived value.

## Typography

This design system utilizes **IBM Plex Sans** for its exceptional balance between technical precision and humanist warmth. It performs beautifully in both Arabic and English, ensuring a seamless bilingual experience.

- **Headlines:** Use Medium or SemiBold weights to establish a sturdy hierarchy. High-level displays use tighter letter spacing for a sophisticated, editorial look.
- **Body:** Standardized at 16px or 18px to ensure high legibility and a relaxed reading pace.
- **Labels:** Small labels utilize slightly increased letter spacing and uppercase styling to denote metadata or category tags without cluttering the visual field.

## Layout & Spacing

The layout follows a **Fixed Grid** model on desktop (12 columns) centered within the viewport to maintain a premium "boutique" feel. On mobile, it transitions to a fluid single-column layout with 16px side margins.

A strict 4px baseline grid ensures vertical rhythm. **Generous Whitespace** is a core component; components should never feel crowded. Section spacing should default to `xxl` (64px) to allow the "breathing room" required of a high-end brand. The RTL (Right-to-Left) implementation must ensure that iconography and logical flow (e.g., "Next" arrows) are mirrored correctly for the Arabic-speaking market.

## Elevation & Depth

Visual hierarchy is achieved through a combination of **Tonal Layering** and **Ambient Shadows**.

- **Level 0 (Base):** The Warm Ivory surface.
- **Level 1 (Cards):** Uses a #212529 shadow with 4% opacity, 12px blur, and a 4px vertical offset. This creates a "soft lift" that feels natural under warm gallery lighting.
- **Overlays:** Modals and menus use a slightly more pronounced shadow (8% opacity) to separate them from the primary content.
- **Borders:** Hairline borders (#E7E1D8) are used sparingly to define boundaries where tonal contrast is insufficient, maintaining a "minimalist luxury" aesthetic.

## Shapes

The shape language is defined by a **16px (1rem) corner radius** for all primary cards, containers, and image masks. This specific curvature provides a soft, inviting feel that mimics the organic shapes of dates and pecans.

Smaller elements, such as buttons and input fields, should maintain a consistent 8px (0.5rem) radius to ensure they feel precise and functional within the softer container environment. Pills (full radius) are reserved exclusively for status indicators and chips.

## Components

- **Buttons:** Primary buttons use the Warm Pecan Brown background with Ivory text. Secondary buttons use a hairline border with Pecan Brown text. Use a 16px vertical padding for a substantial, "clickable" feel.
- **Cards:** Product cards must feature a subtle transition on hover—elevating slightly and darkening the shadow. Images within cards should always use the 16px rounded corner.
- **Inputs:** Text fields use a transparent background with the #E7E1D8 border. Focus states transition the border to Warm Pecan Brown.
- **Chips:** Used for dietary labels (e.g., "Vegan," "No Added Sugar"). These use a Soft Warm-Gold tint at 10% opacity with Gold text.
- **Lists:** Use custom iconography for list bullets, such as a stylized pecan or a simple gold dot, to reinforce the gourmet narrative.
- **Product Badges:** Elegant, small circular badges for "Limited Edition" or "Best Seller" should use a Deep Espresso background with Gold text.
