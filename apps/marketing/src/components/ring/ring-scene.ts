/**
 * The Dahab 3D ring: a solitaire built from three.js primitives (no third-party model to
 * license): a lathe-turned band, a prong-free head and a round brilliant stone, lit by
 * three's procedural RoomEnvironment. Physically based materials, so swapping the metal is a
 * material change, not a new texture. Loaded only when the section nears the viewport.
 */
import {
  ACESFilmicToneMapping,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export type Metal = 'gold' | 'white' | 'rose';
export type Stone = 'diamond' | 'emerald' | 'ruby';

/** Base colours of real alloys (linear-ish sRGB reflectance). */
const METAL_COLOR: Record<Metal, number> = {
  gold: 0xf1c46a,
  white: 0xdcdcd8,
  rose: 0xe8a48c,
};
const STONE_COLOR: Record<Stone, number> = {
  diamond: 0xffffff,
  emerald: 0x1e9e62,
  ruby: 0xc0143c,
};

function bandGeometry() {
  // Cross-section of a comfort-fit band (x = radius, y = width), revolved around Y.
  const r = 1;
  const t = 0.16;
  const w = 0.24;
  const pts: Vector2[] = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    // a rounded rectangle via superellipse
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = r + t / 2 + (t / 2) * Math.sign(c) * Math.pow(Math.abs(c), 0.5);
    const y = (w / 2) * Math.sign(s) * Math.pow(Math.abs(s), 0.5);
    pts.push(new Vector2(x, y));
  }
  const g = new LatheGeometry(pts, 128);
  g.rotateX(Math.PI / 2); // the ring stands up, facing the camera
  return g;
}

function stoneGeometry() {
  // Round brilliant profile: table, crown, girdle, pavilion (radius, height).
  const pts = [
    new Vector2(0, -0.33),
    new Vector2(0.3, -0.06),
    new Vector2(0.34, 0),
    new Vector2(0.34, 0.03),
    new Vector2(0.21, 0.15),
    new Vector2(0, 0.15),
  ];
  // Few segments + flat shading = visible facets.
  return new LatheGeometry(pts, 16);
}

export interface RingScene {
  setMetal(m: Metal): void;
  setStone(s: Stone): void;
  /** Absolute yaw in radians (scroll + drag), applied on the next frame. */
  setYaw(y: number): void;
  render(): void;
  resize(w: number, h: number): void;
  dispose(): void;
}

export function createRingScene(
  canvas: HTMLCanvasElement,
  opts: { pixelRatio: number }
): RingScene {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(Math.min(opts.pixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  scene.environment = env;

  const camera = new PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0.9, 6.6);
  camera.lookAt(0, 0.15, 0);

  const metal = new MeshPhysicalMaterial({
    side: DoubleSide,
    color: new Color(METAL_COLOR.gold),
    metalness: 1,
    roughness: 0.16,
    clearcoat: 0.6,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.25,
  });
  // An opaque, faceted, mirror-polished stone: crisp facet flashes from the environment
  // without the transmission pass (which samples nothing useful on a transparent canvas).
  const gem = new MeshPhysicalMaterial({
    color: new Color(STONE_COLOR.diamond),
    metalness: 0.15,
    roughness: 0.02,
    ior: 2.42,
    specularIntensity: 1,
    clearcoat: 1,
    clearcoatRoughness: 0,
    iridescence: 0.45,
    iridescenceIOR: 1.8,
    envMapIntensity: 3.2,
    flatShading: true,
  });

  const ring = new Group();
  ring.add(new Mesh(bandGeometry(), metal));

  // Head: a short collet column under the stone (no prongs, per Ahmad 2026-10-07).
  const head = new Group();
  head.position.set(0, 1.18, 0);
  const collet = new Mesh(new CylinderGeometry(0.16, 0.1, 0.18, 32), metal);
  collet.position.y = 0.0;
  head.add(collet);
  // A low metal cup cradles the pavilion so the stone sits in the setting, not on a point.
  const cup = new Mesh(new CylinderGeometry(0.25, 0.15, 0.14, 48, 1, true), metal);
  cup.position.y = 0.16;
  head.add(cup);
  const stone = new Mesh(stoneGeometry(), gem);
  stone.scale.setScalar(1.3);
  stone.position.y = 0.42;
  head.add(stone);
  ring.add(head);
  ring.rotation.x = -0.18;
  ring.position.y = -0.25;
  scene.add(ring);

  let yaw = 0;
  return {
    setMetal(m) {
      metal.color.setHex(METAL_COLOR[m]);
    },
    setStone(s) {
      gem.color.setHex(STONE_COLOR[s]);
      gem.iridescence = s === 'diamond' ? 0.45 : 0.15;
      gem.metalness = s === 'diamond' ? 0.15 : 0.05;
    },
    setYaw(y) {
      yaw = y;
    },
    render() {
      // a three-quarter view at rest, so the stone and the band's width both read
      ring.rotation.y = yaw + 0.65;
      renderer.render(scene, camera);
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    dispose() {
      renderer.dispose();
      pmrem.dispose();
      env.dispose();
    },
  };
}
