'use client';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';

type ShaderRefs = {
  scene: THREE.Scene | null;
  camera: THREE.OrthographicCamera | null;
  renderer: THREE.WebGLRenderer | null;
  mesh: THREE.Mesh | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniforms: any;
  animationId: number | null;
};

export function WebGLShader() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const refsRef = useRef<ShaderRefs>({
    scene: null,
    camera: null,
    renderer: null,
    mesh: null,
    uniforms: null,
    animationId: null,
  });

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const refs = refsRef.current;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Vertex shader: full-screen quad pass-through
    const vertexShader = /* glsl */ `
      attribute vec3 position;
      void main() {
        gl_Position = vec4(position, 1.0);
      }
    `;

    // Fragment shader: RGB-split sine field tinted Ebda gold.
    // The original r/g/b channels each drive a separate sine filament.
    // We weight the final color toward vec3(0.80, 0.66, 0.45) so bright
    // peaks glow gold and dim areas fade to black — Ebda lift #CBA873
    // (rgb 0.80, 0.66, 0.45), Ruling D1016-ORANGE-1.
    const fragmentShader = /* glsl */ `
      precision highp float;
      uniform vec2 resolution;
      uniform float time;
      uniform float xScale;
      uniform float yScale;
      uniform float distortion;

      void main() {
        vec2 p = (gl_FragCoord.xy * 2.0 - resolution) / min(resolution.x, resolution.y);
        float d = length(p) * distortion;

        float rx = p.x * (1.0 + d);
        float gx = p.x;
        float bx = p.x * (1.0 - d);

        float r = 0.05 / abs(p.y + sin((rx + time) * xScale) * yScale);
        float g = 0.05 / abs(p.y + sin((gx + time) * xScale) * yScale);
        float b = 0.05 / abs(p.y + sin((bx + time) * xScale) * yScale);

        // Tint toward Ebda lift: a gold light-field on black.
        vec3 tint = vec3(0.80, 0.66, 0.45);
        vec3 color = vec3(r, g, b) * tint;

        gl_FragColor = vec4(color, 1.0);
      }
    `;

    const parent = canvas.parentElement;
    const w = parent ? parent.clientWidth : window.innerWidth;
    const h = parent ? parent.clientHeight : window.innerHeight;

    // Scene
    refs.scene = new THREE.Scene();
    refs.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, -1);

    // Full-screen triangle pair (two triangles = one quad)
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array([
      -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0,
    ]);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    refs.uniforms = {
      resolution: { value: new THREE.Vector2(w, h) },
      time: { value: 0.0 },
      xScale: { value: 1.0 },
      yScale: { value: 0.5 },
      distortion: { value: 0.05 },
    };

    const material = new THREE.RawShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: refs.uniforms,
      side: THREE.DoubleSide,
    });

    refs.mesh = new THREE.Mesh(geometry, material);
    refs.scene.add(refs.mesh);

    refs.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    refs.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    refs.renderer.setSize(w, h, false);

    const animate = () => {
      if (!refs.renderer || !refs.scene || !refs.camera) return;
      refs.uniforms.time.value += 0.01;
      refs.renderer.render(refs.scene, refs.camera);
      refs.animationId = requestAnimationFrame(animate);
    };

    // Render at least one frame always; only loop RAF when motion is allowed
    if (refs.renderer && refs.scene && refs.camera) {
      refs.renderer.render(refs.scene, refs.camera);
    }
    if (!prefersReducedMotion) {
      refs.animationId = requestAnimationFrame(animate);
    }

    // Resize to parent via ResizeObserver
    const handleResize = (width: number, height: number) => {
      if (!refs.renderer || !refs.uniforms) return;
      refs.renderer.setSize(width, height, false);
      refs.uniforms.resolution.value.set(width, height);
    };

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        handleResize(width, height);
      }
    });
    if (parent) {
      ro.observe(parent);
    }

    return () => {
      ro.disconnect();
      if (refs.animationId !== null) {
        cancelAnimationFrame(refs.animationId);
        refs.animationId = null;
      }
      if (refs.mesh) {
        refs.mesh.geometry.dispose();
        (refs.mesh.material as THREE.RawShaderMaterial).dispose();
      }
      if (refs.renderer) {
        refs.renderer.dispose();
      }
      refs.scene = null;
      refs.camera = null;
      refs.renderer = null;
      refs.mesh = null;
      refs.uniforms = null;
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />;
}
