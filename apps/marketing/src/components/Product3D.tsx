'use client';

import dynamic from 'next/dynamic';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import type { ActiveModel3dLook } from '@ebda/shared';
import type { Model3dCopy } from '../lib/content';
import { egp } from '../lib/demo-stores';
import { ensureLookFont } from '../lib/looks-frag';
import { MODEL3D, MODEL3D_IDS, qrPath, stillBase, type Model3dId } from '../lib/model3d';
import type { Locale } from '../lib/site';

/**
 * The product's real viewer (packages/ui/src/model3d, the same component the storefront PDP
 * and the admin preview run), loaded as its own chunk and only once the section is near the
 * screen: three.js never lands in the initial bundle.
 */
const ProductModelViewer = dynamic(() => import('@ebda/ui/model3d'), {
  ssr: false,
  loading: () => null,
});

type Mode = 'pending' | 'auto' | 'manual' | 'still';

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

/** Reduced motion and Save-Data both mean "do not start a 1 MB download or a render loop by yourself". */
function shouldAskFirst(): boolean {
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
    ?.saveData;
  return reduced || !!saveData;
}

function Still({ base, alt, priority = false }: { base: string; alt: string; priority?: boolean }) {
  return (
    <picture className="m3d-still">
      <source type="image/avif" srcSet={`${base}.avif`} />
      <img
        src={`${base}.webp`}
        width={720}
        height={720}
        alt={alt}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
      />
    </picture>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

/**
 * "Your product page, live": a phone showing a product page in one look's style (colours and
 * fonts of Qamar A, Night souq or Lamma A) whose media slot runs the real 3D viewer. The server
 * renders the first still, so no-JS visitors see a finished page. With JS, the model loads once
 * the section is within a screen of the viewport; reduced motion / Save-Data / no WebGL keep
 * the per-colour stills (reduced motion and Save-Data get a button to load the model).
 * Chips switch vertical (the phone's skin and model), the swatches drive the shoe's glTF
 * variants. AR: the viewer's own button on phones (Scene Viewer on Android, Quick Look on iOS),
 * a build-time QR on desktop.
 */
export function Product3D({ copy, locale }: { copy: Model3dCopy; locale: Locale }) {
  const rtl = locale === 'ar';
  const [active, setActive] = useState<Model3dId>('qamar');
  const [variant, setVariant] = useState<string>(MODEL3D.qamar.variants[0].id);
  const [mode, setMode] = useState<Mode>('pending');
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  const [switched, setSwitched] = useState(false);
  const [arrived, setArrived] = useState(false); // landed from a QR scan
  const stageRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const def = MODEL3D[active];
  const v = copy.verticals[active];
  const hasVariants = def.variants.length > 0;
  const activeVariant = hasVariants ? variant : null;

  // A QR scan lands on /?m=<vertical>#model3d: open that vertical, bring the section back into view
  // (the sections above settle after the hash jump and push it away) and load the model right away.
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get('m');
    if (!m || !(MODEL3D_IDS as readonly string[]).includes(m)) return;
    setActive(m as Model3dId);
    setVariant(MODEL3D[m as Model3dId].variants[0]?.id ?? '');
    setArrived(true);
    const toSection = () => document.getElementById('model3d')?.scrollIntoView();
    const t = [setTimeout(toSection, 300), setTimeout(toSection, 1200)];
    return () => t.forEach(clearTimeout);
  }, []);

  // Decide how the model loads: by itself near the screen, on request, or never (no WebGL).
  useEffect(() => {
    setMode(!webglAvailable() ? 'still' : shouldAskFirst() ? 'manual' : 'auto');
  }, []);

  useEffect(() => {
    if (arrived && mode === 'auto') setLive(true);
  }, [arrived, mode]);

  // Fonts of the three looks, once the section is near the screen (or a chip was chosen).
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        MODEL3D_IDS.forEach(id => ensureLookFont(id));
        if (mode === 'auto') setLive(true);
      },
      { rootMargin: `${Math.round(window.innerHeight)}px 0px` }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mode]);

  const select = (id: Model3dId, focus = false) => {
    if (focus) tabRefs.current[MODEL3D_IDS.indexOf(id)]?.focus();
    if (id === active) return; // the live model is already this one
    setSwitched(true);
    setActive(id);
    setVariant(MODEL3D[id].variants[0]?.id ?? '');
    setReady(false);
    ensureLookFont(id);
  };

  // Warm the next model on hover or focus, so the swap behind the still is quick.
  const prefetch = (id: Model3dId) => {
    if (mode === 'auto' || live)
      void fetch(MODEL3D[id].glb, { priority: 'low' } as RequestInit).catch(() => {});
  };

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const n = MODEL3D_IDS.length;
    // In RTL the tab row is mirrored: the visual right arrow goes to the previous tab.
    const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next = -1;
    if (e.key === fwd) next = (i + 1) % n;
    else if (e.key === back) next = (i - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    select(MODEL3D_IDS[next], true);
  };

  const look = useMemo<ActiveModel3dLook | undefined>(
    () => (activeVariant ? { materials: {}, gltfVariant: activeVariant } : undefined),
    [activeVariant]
  );

  const skin = {
    '--bg': def.skin.bg,
    '--ink': def.skin.ink,
    '--mut': def.skin.mut,
    // Ebda's own demos carry no orange (Ruling METAL-1): the serum look's amber accent becomes Ebda gold in this demo only.
    '--ac': active === 'jasmine' ? '#B08D57' : def.skin.ac,
    '--fd': `'${def.skin.fd}'`,
    '--fb': `'${def.skin.fb}'`,
  } as CSSProperties;
  const still = stillBase(active, activeVariant);
  const showViewer = live && mode !== 'still';
  const absolute = (p: string) => new URL(p, window.location.href).href;

  return (
    <div className="m3d-wrap">
      <div className="m3d-side">
        <div className="looks-tabs m3d-tabs" role="tablist" aria-label={copy.tablistLabel}>
          {MODEL3D_IDS.map((id, i) => (
            <button
              key={id}
              ref={el => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`m3d-tab-${id}`}
              aria-selected={id === active}
              aria-controls="m3d-panel"
              tabIndex={id === active ? 0 : -1}
              className="looks-tab"
              onClick={() => select(id)}
              onPointerEnter={() => prefetch(id)}
              onFocus={() => prefetch(id)}
              onKeyDown={e => onTabKey(e, i)}
            >
              <span className="looks-tab-name">{copy.verticals[id].name}</span>
              <span className="looks-tab-kind">{copy.verticals[id].kind}</span>
            </button>
          ))}
        </div>
        <div className="m3d-qr">
          <img
            key={`${active}-${locale}`}
            src={qrPath(locale, active)}
            width={132}
            height={132}
            alt={copy.qr.alt.replace('{name}', v.product.name)}
            loading="lazy"
            decoding="async"
          />
          <div>
            <h3>{copy.qr.title}</h3>
            <p>{copy.qr.hint}</p>
          </div>
        </div>
        <p className="muted small m3d-foot">{copy.footnote}</p>
      </div>

      <div className="m3d-stage" ref={stageRef}>
        <div
          id="m3d-panel"
          role="tabpanel"
          aria-labelledby={`m3d-tab-${active}`}
          aria-describedby="m3d-keys"
          className="look-phone m3d-phone"
        >
          <span className="look-badge">{copy.badge}</span>
          <div
            className={`look-screen m3d-screen m3d${switched ? ' m3d-in' : ''}`}
            key={active}
            style={skin}
            dir={rtl ? 'rtl' : 'ltr'}
            lang={locale}
            role="region"
            aria-label={copy.pageLabel}
          >
            <header className="m3d-hd" aria-hidden="true">
              <Icon d="M4 7h16M4 12h16M4 17h16" />
              <b className="m3d-logo">{v.name}</b>
              <Icon d="M6 8h12l-1 12H7zM9 8V7a3 3 0 016 0v1" />
            </header>
            <div className="m3d-media" data-ready={ready ? '' : undefined}>
              {showViewer ? (
                <ProductModelViewer
                  src={absolute(def.glb)}
                  poster={`${still}.webp`}
                  alt={v.alt}
                  look={look}
                  labels={{
                    loading: copy.loading,
                    error: copy.error,
                    hint: copy.hint,
                    ar: copy.ar,
                  }}
                  ar={{
                    enabled: true,
                    title: v.product.name,
                    fallbackUrl: window.location.href.split('#')[0],
                  }}
                  onLoad={() => setReady(true)}
                />
              ) : (
                <>
                  <Still base={still} alt={v.alt} priority={active === 'qamar' && !switched} />
                  {mode === 'manual' && (
                    <button type="button" className="m3d-load" onClick={() => setLive(true)}>
                      {copy.load}
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="m3d-info">
              <h3 className="m3d-name">{v.product.name}</h3>
              <p className="m3d-price">{egp(locale, v.product.price)}</p>
              <p className="m3d-desc">{v.product.desc}</p>
              {hasVariants && v.variants && (
                <div className="m3d-opt" role="group" aria-label={copy.colourLabel}>
                  <span className="m3d-opt-label">{copy.colourLabel}</span>
                  <div className="m3d-sw">
                    {def.variants.map(x => (
                      <button
                        key={x.id}
                        type="button"
                        className="m3d-swatch"
                        aria-pressed={variant === x.id}
                        onClick={() => setVariant(x.id)}
                      >
                        <span
                          className="m3d-dot"
                          style={{ background: x.hex }}
                          aria-hidden="true"
                        />
                        {v.variants?.[x.id]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <span className="m3d-cta" aria-hidden="true">
                {copy.addToCart}
              </span>
            </div>
          </div>
        </div>
        <p className="sr-only" id="m3d-keys">
          {copy.keys}
        </p>
      </div>
    </div>
  );
}
