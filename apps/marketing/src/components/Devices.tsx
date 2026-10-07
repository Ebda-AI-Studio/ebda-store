import type { ReactNode } from 'react';
import type { TemplateId } from '../lib/demo-stores';
import { DEVICE_SHOTS } from '../lib/device-shots';

/** Device frames drawn in CSS (bezel, glass, reflections); the screen shows a real capture. */
export function Phone({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`dev-phone ${className}`.trim()}>
      <div className="dev-screen">
        <span className="dev-island" />
        {children}
      </div>
    </div>
  );
}

export function Tablet({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`dev-tablet ${className}`.trim()}>
      <div className="dev-screen">{children}</div>
    </div>
  );
}

export function Laptop({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`dev-laptop ${className}`.trim()}>
      <div className="dev-lid">
        <div className="dev-screen">{children}</div>
      </div>
      <div className="dev-base" />
    </div>
  );
}

type DeviceKind = 'phone' | 'tablet' | 'laptop';
const SRC_WIDTHS: Record<DeviceKind, [number, number]> = {
  phone: [600, 900],
  tablet: [840, 1240],
  laptop: [1280, 1920],
};

/**
 * A real storefront capture (apps/web, rendered at the device's true viewport) filling a
 * device screen, scaled as a whole like a screenshot. `eager` only for the first frame in view.
 */
export function Screen({
  tpl,
  device,
  sizes,
  eager = false,
}: {
  tpl: TemplateId;
  device: DeviceKind;
  sizes: string;
  eager?: boolean;
}) {
  const shot = DEVICE_SHOTS[tpl][device];
  const [a, b] = SRC_WIDTHS[device];
  const set = (ext: string) =>
    `/devices/${tpl}-${device}-${a}.${ext} ${a}w, /devices/${tpl}-${device}-${b}.${ext} ${b}w`;
  return (
    <picture className="shot">
      <source type="image/avif" srcSet={set('avif')} sizes={sizes} />
      <img
        src={`/devices/${tpl}-${device}-${b}.webp`}
        srcSet={set('webp')}
        sizes={sizes}
        width={shot.w}
        height={shot.h}
        alt=""
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
      />
    </picture>
  );
}
