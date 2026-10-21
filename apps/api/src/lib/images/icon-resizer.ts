/**
 * PWA icon resizing through the Cloudflare Images binding (`env.IMAGES`, Ruling D1016-ICONS-1).
 *
 * No image library runs on workerd (`sharp` is banned under apps/api, FU46-8a); Cloudflare Images
 * does the work instead: `env.IMAGES.input(bytes).transform({...}).output({ format })`. Docs:
 * https://developers.cloudflare.com/images/optimization/binding/ (`border` is Workers-only and is
 * applied after the resize; `background` fills transparent pixels).
 *
 * The binding exists only when the deploy carries it (`EBDA_IMAGES_BINDING=true`); outside a
 * Worker, or without it, `imagesBinding()` is null and callers keep the pass-through behaviour.
 */
import { cfBindings } from '../../cf/bindings';
import { pngDimensions } from '../upload-sniff';

/** The slice of the Images binding this module uses (workers-types `ImagesBinding`). */
export interface ImagesBindingLike {
  input(stream: ReadableStream<Uint8Array>): ImageTransformerLike;
}
interface ImageTransformerLike {
  transform(options: Record<string, unknown>): ImageTransformerLike;
  output(options: { format: string }): Promise<{ response(): Response }>;
}

export function imagesBinding(): ImagesBindingLike | null {
  const b = cfBindings()?.IMAGES as ImagesBindingLike | undefined;
  return b && typeof b.input === 'function' ? b : null;
}

/** Android adaptive / maskable icons keep the art inside the central 80% (the safe zone). */
export const MASKABLE_SAFE_ZONE = 0.8;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** The padding colour reaches an image request: a hex colour or white, nothing else. */
export function iconBackground(value: string | null | undefined): string {
  return value && HEX.test(value) ? value : '#FFFFFF';
}

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new Response(new Uint8Array(bytes)).body as ReadableStream<Uint8Array>;
}

/**
 * One square PNG of `size` px from a square PNG source. `maskable` scales the art into the central
 * 80% and pads it to `size` with the opaque `background`. Throws when the binding fails or the
 * answer is not a PNG of exactly `size` px — the caller falls back for the whole set.
 */
export async function renderIcon(
  images: ImagesBindingLike,
  source: Buffer,
  size: number,
  opts: { maskable?: boolean; background?: string } = {}
): Promise<Buffer> {
  let transform: Record<string, unknown> = { width: size, height: size, fit: 'contain' };
  if (opts.maskable) {
    const inner = Math.round(size * MASKABLE_SAFE_ZONE);
    const pad = (size - inner) / 2;
    if (!Number.isInteger(pad)) throw new Error(`maskable pad for ${size}px is not whole`);
    const background = iconBackground(opts.background);
    transform = {
      width: inner,
      height: inner,
      fit: 'contain',
      background,
      border: { color: background, width: pad },
    };
  }
  const result = await images.input(streamOf(source)).transform(transform).output({
    format: 'image/png',
  });
  const out = Buffer.from(await result.response().arrayBuffer());
  const dims = pngDimensions(out);
  if (!dims || dims.width !== size || dims.height !== size)
    throw new Error(
      `Images answered ${dims ? `${dims.width}x${dims.height}` : 'a non-PNG'} for ${size}px`
    );
  return out;
}
