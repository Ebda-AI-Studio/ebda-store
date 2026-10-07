import type { SceneId } from '../lib/content';

/** Scene order: the souq laptop scene is wide (first row), the four phone scenes follow. */
const ORDER: SceneId[] = ['souq', 'lamma', 'dahab', 'qamar', 'jasmine'];

/**
 * The real storefront captures, composited into photographed rooms (scripts/scenes/
 * compose.mjs: a CSS 3D transform onto a real laptop screen, or a phone lying on the
 * photographed surface, with shadow, screen light and glass). Photos: CC0 stock, credited in
 * public/scenes/CREDITS.md. Lazy, sized images; the grade is a CSS overlay.
 */
export function Scenes({ items }: { items: Record<SceneId, { place: string; alt: string }> }) {
  return (
    <div className="scene-grid">
      {ORDER.map(id => (
        <figure key={id} className="scene" data-scene={id}>
          <picture>
            <source
              type="image/avif"
              srcSet={`/scenes/${id}-800.avif 800w, /scenes/${id}-1200.avif 1200w`}
              sizes="(min-width: 900px) 50vw, 100vw"
            />
            <img
              src={`/scenes/${id}-1200.webp`}
              srcSet={`/scenes/${id}-800.webp 800w, /scenes/${id}-1200.webp 1200w`}
              sizes="(min-width: 900px) 50vw, 100vw"
              width={1200}
              height={id === 'souq' ? 675 : 900}
              alt={items[id].alt}
              loading="lazy"
              decoding="async"
            />
          </picture>
          <figcaption>{items[id].place}</figcaption>
        </figure>
      ))}
    </div>
  );
}
