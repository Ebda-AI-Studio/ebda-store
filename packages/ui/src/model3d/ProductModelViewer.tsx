'use client';

/**
 * Interactive product 3D viewer (glTF/GLB) with AR hand-off — shared by the
 * storefront PDP and the admin preview. Built on three.js primitives instead
 * of <model-viewer> (Ruling R-EBDA-3D-1: its peer `three@^0.183` conflicts
 * with the three 0.184 we ship). Import it ONLY through `next/dynamic` with
 * `ssr: false`, so three never lands in a page's initial bundle.
 *
 * Design: docs/plans/2026-10-07-product-3d-viewer.md.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import type { ActiveModel3dLook } from '@ebda/shared';
import { arPlatform, sceneViewerIntent, type ArPlatform } from './ar';

export type ArSource = 'usdz' | 'generated' | 'scene-viewer';

export interface ProductModelViewerLabels {
  loading: string;
  error: string;
  hint: string;
  ar: string;
}

export interface ProductModelViewerProps {
  /** GLB URL (https, or a blob: URL for a local admin preview). */
  src: string;
  poster?: string | null;
  /** Accessible name of the 3D canvas (merchant alt text, else product name). */
  alt: string;
  labels: ProductModelViewerLabels;
  look?: ActiveModel3dLook;
  /** Slow turntable until the first interaction. Always off under reduced motion. */
  autoRotate?: boolean;
  ar?: {
    enabled: boolean;
    usdzUrl?: string | null;
    /** Title Scene Viewer shows. */
    title: string;
    /** Page Android returns to when Scene Viewer is unavailable. */
    fallbackUrl: string;
  };
  className?: string;
  onLoad?: (info: { ms: number; bytes: number }) => void;
  onError?: (reason: string) => void;
  onInteract?: () => void;
  onArClick?: (source: ArSource) => void;
  onLookApplied?: () => void;
  /** Receives the imperative handle. Use this, not `ref`, through next/dynamic
   *  (a dynamic() wrapper does not forward refs). */
  handleRef?: { current: ProductModelViewerHandle | null };
}

export interface ProductModelViewerHandle {
  /** Render the current view to an image (poster capture). */
  capture: () => Promise<Blob | null>;
}

interface Original {
  color: THREE.Color;
  metalness: number;
  roughness: number;
}

type StdMaterial = THREE.MeshStandardMaterial;

function isStd(m: THREE.Material): m is StdMaterial {
  return (m as StdMaterial).isMeshStandardMaterial === true;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export const ProductModelViewer = forwardRef<ProductModelViewerHandle, ProductModelViewerProps>(
  function ProductModelViewer(
    {
      src,
      poster,
      alt,
      labels,
      look,
      autoRotate = true,
      ar,
      className = '',
      onLoad,
      onError,
      onInteract,
      onArClick,
      onLookApplied,
      handleRef,
    },
    ref
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [platform, setPlatform] = useState<ArPlatform>('none');
    const [arBusy, setArBusy] = useState(false);

    // Live three objects, kept out of React state (no re-render per frame).
    const sceneRef = useRef<{
      renderer: THREE.WebGLRenderer;
      scene: THREE.Scene;
      camera: THREE.PerspectiveCamera;
      controls: OrbitControls;
      gltf: GLTF | null;
      originals: Map<THREE.Material, Original>;
      render: () => void;
    } | null>(null);
    const lookRef = useRef<ActiveModel3dLook | undefined>(look);
    lookRef.current = look;
    const cbRef = useRef({ onLoad, onError, onInteract, onLookApplied });
    cbRef.current = { onLoad, onError, onInteract, onLookApplied };

    useEffect(() => setPlatform(arPlatform()), []);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      let disposed = false;
      let frame = 0;
      let visible = true;
      const reduced = prefersReducedMotion();
      setState('loading');

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NeutralToneMapping;
      const canvas = renderer.domElement;
      canvas.className = 'block h-full w-full touch-none outline-none';
      canvas.tabIndex = 0;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', alt);
      host.appendChild(canvas);

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envTexture;

      const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = !reduced;
      controls.enablePan = false;
      controls.autoRotate = autoRotate && !reduced;
      controls.autoRotateSpeed = 1.2;

      const resize = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(host);

      const render = () => renderer.render(scene, camera);
      const loop = () => {
        frame = 0;
        if (disposed || !visible) return;
        controls.update();
        render();
        frame = requestAnimationFrame(loop);
      };
      const io = new IntersectionObserver(entries => {
        visible = entries.some(e => e.isIntersecting);
        if (visible && !frame) frame = requestAnimationFrame(loop);
      });
      io.observe(host);

      let interacted = false;
      const markInteract = () => {
        controls.autoRotate = false;
        if (!interacted) {
          interacted = true;
          cbRef.current.onInteract?.();
        }
      };
      controls.addEventListener('start', markInteract);

      // Keyboard: arrows rotate, +/- zoom (OrbitControls' own keys pan).
      const onKey = (e: KeyboardEvent) => {
        const step = Math.PI / 18;
        let handled = true;
        if (e.key === 'ArrowLeft') controls.rotateLeft(step);
        else if (e.key === 'ArrowRight') controls.rotateLeft(-step);
        else if (e.key === 'ArrowUp') controls.rotateUp(step);
        else if (e.key === 'ArrowDown') controls.rotateUp(-step);
        // sign-ok: keyboard key, not a number
        else if (e.key === '+' || e.key === '=') controls.dollyIn(1.1);
        else if (e.key === '-' || e.key === '_') controls.dollyOut(1.1);
        else handled = false;
        if (handled) {
          e.preventDefault();
          markInteract();
          controls.update();
          render();
        }
      };
      canvas.addEventListener('keydown', onKey);

      const originals = new Map<THREE.Material, Original>();
      sceneRef.current = { renderer, scene, camera, controls, gltf: null, originals, render };

      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const started = performance.now();
      let bytes = 0;
      loader
        .loadAsync(src, ev => {
          if (ev.loaded) bytes = ev.loaded;
        })
        .then(gltf => {
          if (disposed) return;
          const root = gltf.scene;
          // Clone every standard material once so a recolour never leaks into
          // a material shared with another mesh we did not mean to touch.
          root.traverse(obj => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of list) {
              if (isStd(m) && !originals.has(m)) {
                originals.set(m, {
                  color: m.color.clone(),
                  metalness: m.metalness,
                  roughness: m.roughness,
                });
              }
            }
          });
          // Frame the model.
          const box = new THREE.Box3().setFromObject(root);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
          const dist = (radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.35;
          camera.near = dist / 100;
          camera.far = dist * 100;
          camera.position.set(center.x + dist * 0.5, center.y + dist * 0.25, center.z + dist);
          camera.updateProjectionMatrix();
          controls.target.copy(center);
          controls.minDistance = dist * 0.35;
          controls.maxDistance = dist * 3;
          controls.update();
          scene.add(root);
          sceneRef.current!.gltf = gltf;
          void applyLook(lookRef.current).then(() => {
            if (disposed) return;
            render();
            setState('ready');
            cbRef.current.onLoad?.({ ms: Math.round(performance.now() - started), bytes });
          });
        })
        .catch((err: unknown) => {
          if (disposed) return;
          setState('error');
          cbRef.current.onError?.(err instanceof Error ? err.message.slice(0, 200) : 'load_failed');
        });

      return () => {
        disposed = true;
        if (frame) cancelAnimationFrame(frame);
        io.disconnect();
        ro.disconnect();
        canvas.removeEventListener('keydown', onKey);
        controls.removeEventListener('start', markInteract);
        controls.dispose();
        scene.traverse(obj => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry?.dispose();
          const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of list) {
            for (const v of Object.values(m)) {
              if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
            }
            m.dispose();
          }
        });
        envTexture.dispose();
        pmrem.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        canvas.remove();
        sceneRef.current = null;
      };
      // `alt`/`autoRotate` changes do not reload the model; src does.
    }, [src]);

    useEffect(() => {
      const c = hostRef.current?.querySelector('canvas');
      if (c) c.setAttribute('aria-label', alt);
    }, [alt]);

    /** Apply a finish: recolour named materials, switch glTF variant. */
    async function applyLook(next: ActiveModel3dLook | undefined): Promise<void> {
      const live = sceneRef.current;
      if (!live?.gltf) return;
      const { gltf, originals } = live;
      // glTF KHR_materials_variants: swap mesh materials per the file's mapping.
      const variantNames = (
        (gltf.userData?.gltfExtensions as Record<string, { variants?: { name: string }[] }>)?.[
          'KHR_materials_variants'
        ]?.variants ?? []
      ).map(v => v.name);
      const variantIndex = next?.gltfVariant ? variantNames.indexOf(next.gltfVariant) : -1;
      const swaps: Promise<void>[] = [];
      gltf.scene.traverse(obj => {
        const mesh = obj as THREE.Mesh & {
          userData: { variantDefault?: THREE.Material | THREE.Material[] };
        };
        const ext = (mesh.userData?.gltfExtensions as Record<string, unknown> | undefined)?.[
          'KHR_materials_variants'
        ] as { mappings?: { material: number; variants: number[] }[] } | undefined;
        if (!mesh.isMesh || !ext?.mappings) return;
        if (!mesh.userData.variantDefault) mesh.userData.variantDefault = mesh.material;
        const mapping =
          variantIndex >= 0 ? ext.mappings.find(m => m.variants.includes(variantIndex)) : undefined;
        if (!mapping) {
          mesh.material = mesh.userData.variantDefault;
          return;
        }
        swaps.push(
          gltf.parser.getDependency('material', mapping.material).then((mat: THREE.Material) => {
            if (isStd(mat) && !originals.has(mat)) {
              originals.set(mat, {
                color: mat.color.clone(),
                metalness: mat.metalness,
                roughness: mat.roughness,
              });
            }
            mesh.material = mat;
          })
        );
      });
      await Promise.all(swaps);
      // Material recolours on top (by material NAME, as the admin mapped them).
      gltf.scene.traverse(obj => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of list) {
          if (!isStd(m)) continue;
          const orig = originals.get(m);
          const finish = next?.materials[m.name];
          if (finish) {
            m.color.set(finish.color);
            if (finish.metalness != null) m.metalness = finish.metalness;
            if (finish.roughness != null) m.roughness = finish.roughness;
          } else if (orig) {
            m.color.copy(orig.color);
            m.metalness = orig.metalness;
            m.roughness = orig.roughness;
          }
          m.needsUpdate = true;
        }
      });
      live.render();
    }

    useEffect(() => {
      if (state !== 'ready') return;
      void applyLook(look).then(() => cbRef.current.onLookApplied?.());
    }, [look, state]);

    const handle: ProductModelViewerHandle = {
      capture: async () => {
        const live = sceneRef.current;
        if (!live) return null;
        live.render();
        return new Promise<Blob | null>(resolve =>
          live.renderer.domElement.toBlob(b => resolve(b), 'image/webp', 0.9)
        );
      },
    };
    useImperativeHandle(ref, () => handle);
    if (handleRef) handleRef.current = handle;

    async function openAr() {
      if (!ar?.enabled) return;
      if (platform === 'android') {
        onArClick?.('scene-viewer');
        window.location.href = sceneViewerIntent(src, ar.title, ar.fallbackUrl);
        return;
      }
      if (platform !== 'ios') return;
      let href = ar.usdzUrl ?? null;
      let source: ArSource = 'usdz';
      if (!href) {
        const live = sceneRef.current;
        if (!live?.gltf) return;
        setArBusy(true);
        try {
          const data = await new USDZExporter().parseAsync(live.gltf.scene);
          href = URL.createObjectURL(new Blob([data], { type: 'model/vnd.usdz+zip' }));
          source = 'generated';
        } catch {
          setArBusy(false);
          return;
        }
        setArBusy(false);
      }
      onArClick?.(source);
      // Quick Look needs an <a rel="ar"> whose only child is an <img>.
      const a = document.createElement('a');
      a.setAttribute('rel', 'ar');
      a.href = href;
      a.appendChild(document.createElement('img'));
      a.click();
      // Quick Look has read the blob once the sheet opens; free it after.
      if (source === 'generated') setTimeout(() => URL.revokeObjectURL(href!), 60_000);
    }

    const showAr =
      !!ar?.enabled &&
      state === 'ready' &&
      (platform === 'ios' || platform === 'android') &&
      // Scene Viewer fetches the file itself: a blob: preview cannot go there.
      !(platform === 'android' && !/^https:\/\//.test(src));

    return (
      <div className={`relative h-full w-full ${className}`}>
        <div ref={hostRef} className="absolute inset-0" />
        {poster && state !== 'ready' && (
          <img
            src={poster}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
        )}
        {state === 'loading' && (
          <div
            role="status"
            className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center"
          >
            <span className="rounded-full bg-background/85 px-3 py-1 text-xs text-foreground shadow-sm">
              {labels.loading}
            </span>
          </div>
        )}
        {state === 'error' && (
          <div role="alert" className="absolute inset-x-0 bottom-3 flex justify-center px-3">
            <span className="rounded-lg bg-background/90 px-3 py-1.5 text-center text-xs text-foreground shadow-sm">
              {labels.error}
            </span>
          </div>
        )}
        {state === 'ready' && (
          <p className="pointer-events-none absolute inset-x-0 top-2 text-center text-xs text-muted-foreground">
            {labels.hint}
          </p>
        )}
        {showAr && (
          <button
            type="button"
            onClick={() => void openAr()}
            disabled={arBusy}
            className="absolute bottom-3 end-3 inline-flex h-10 items-center gap-1.5 rounded-full bg-foreground px-4 text-sm font-medium text-background shadow-md disabled:opacity-60"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 0v9m8-4.5L12 12 4 7.5"
              />
            </svg>
            {labels.ar}
          </button>
        )}
      </div>
    );
  }
);

export default ProductModelViewer;
