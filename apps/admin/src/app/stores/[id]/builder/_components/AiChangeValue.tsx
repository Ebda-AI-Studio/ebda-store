/**
 * One side (before or after) of an AI-proposed change, shown as a small preview a merchant can read:
 * a colour as a swatch plus its hex, an image as a thumbnail, text clipped, a switch as on/off.
 * Meaning is never colour-only: the value is always written out next to its swatch.
 */
type T = (k: string, p?: Record<string, string | number>) => string;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const IMAGE_URL = /\.(?:png|jpe?g|webp|gif|avif|svg)(?:[?#].*)?$/i;
const CLIP = 80;

function isImageRef(op: string, key: string | undefined, v: unknown): v is string {
  return (
    op === 'setRef' &&
    typeof v === 'string' &&
    v !== '' &&
    (IMAGE_URL.test(v) || /image|img|photo/i.test(key ?? ''))
  );
}

export function AiChangeValue({
  value,
  op,
  field,
  t,
}: {
  value: unknown;
  op: string;
  field?: string;
  t: T;
}) {
  if (value === undefined || value === null || value === '') return <bdi>-</bdi>;
  if (typeof value === 'boolean') {
    const hide = op === 'setSectionHidden' || op === 'setViewportHidden';
    return <bdi>{hide ? t(value ? 'hidden' : 'shown') : t(value ? 'on' : 'off')}</bdi>;
  }
  if (Array.isArray(value)) return <bdi>{t('products_count', { count: value.length })}</bdi>;
  if (typeof value === 'string' && HEX.test(value)) {
    return (
      <span className="inline-flex items-center gap-1" data-preview="colour">
        <span
          aria-hidden="true"
          className="inline-block size-3 rounded-full border border-border"
          style={{ backgroundColor: value }}
        />
        <bdi dir="ltr">{value.toLowerCase()}</bdi>
      </span>
    );
  }
  if (typeof value === 'string' && value.startsWith('token:')) {
    return <bdi data-preview="colour">{value.slice(6)}</bdi>;
  }
  if (isImageRef(op, field, value)) {
    return (
      <span className="inline-flex items-center gap-1" data-preview="image">
        <img
          src={value}
          alt=""
          loading="lazy"
          className="size-8 rounded-md border border-border object-cover"
        />
        <bdi dir="auto" className="max-w-24 truncate">
          {value.split('/').pop()}
        </bdi>
      </span>
    );
  }
  const s = String(value);
  return (
    <bdi dir="auto" data-preview="text" className="line-clamp-2">
      {s.length > CLIP ? `${s.slice(0, CLIP)}…` : s}
    </bdi>
  );
}
