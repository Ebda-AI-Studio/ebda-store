/**
 * Product 3D models — the upload gate (validateGlb / validateUsdz), the
 * binding schemas, and the storefront binding resolver.
 * docs/plans/2026-10-07-product-3d-viewer.md, Rulings R-EBDA-3D-*.
 */
import { describe, it, expect } from 'vitest';
import {
  MODEL3D_MAX_BYTES,
  MODEL3D_MAX_VERTICES,
  model3dBindingsBodySchema,
  model3dErrorMessage,
  model3dSwatchColor,
  model3dUpdateSchema,
  resolveModel3dLook,
  validateGlb,
  validateUsdz,
  type PublicModel3dBinding,
} from '@ebda/shared';
import { buildGlb, buildUsdz, sampleGlb, sampleGltf } from '../helpers/glb-fixtures';

const fail = (bytes: Uint8Array) => {
  const r = validateGlb(bytes);
  return r.ok ? 'OK' : r.code;
};

describe('validateGlb — accepts a well-formed self-contained GLB', () => {
  it('extracts materials, stats and no warnings', () => {
    const r = validateGlb(sampleGlb());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.materials).toEqual([
      { index: 0, name: 'Band' },
      { index: 1, name: 'Stone' },
    ]);
    expect(r.stats).toMatchObject({ vertices: 3, meshes: 1, materials: 2, textures: 0 });
    expect(r.gltfVariants).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('names an unnamed material by position and reads KHR_materials_variants', () => {
    const r = validateGlb(
      sampleGlb({
        materials: [{}, { name: '  Prong  ' }],
        extensionsUsed: ['KHR_materials_variants'],
        extensions: {
          KHR_materials_variants: { variants: [{ name: 'Gold' }, { name: 'Silver' }, {}] },
        },
      })
    );
    expect(r.ok && r.materials.map(m => m.name)).toEqual(['Material 1', 'Prong']);
    expect(r.ok && r.gltfVariants).toEqual(['Gold', 'Silver']);
  });

  it('accepts a GLB with no BIN chunk and the supported compressions', () => {
    expect(fail(buildGlb(sampleGltf({ buffers: [] })))).toBe('OK');
    expect(
      fail(
        sampleGlb({
          extensionsUsed: ['EXT_meshopt_compression', 'EXT_texture_webp'],
          extensionsRequired: ['EXT_meshopt_compression', 'EXT_texture_webp'],
        })
      )
    ).toBe('OK');
  });

  it('counts a POSITION accessor shared by two primitives once', () => {
    const g = sampleGltf({
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0 }, material: 0 },
            { attributes: { POSITION: 0 }, material: 1 },
          ],
        },
      ],
    });
    const r = validateGlb(buildGlb(g, new Uint8Array(36)));
    expect(r.ok && r.stats.vertices).toBe(3);
  });

  it('warns (still accepts) above the soft vertex budget', () => {
    const g = sampleGltf();
    (g.accessors as Array<{ count: number }>)[0].count = 600_000;
    const r = validateGlb(buildGlb(g, new Uint8Array(36)));
    expect(r.ok && r.warnings).toEqual(['MANY_VERTICES']);
  });
});

describe('validateGlb — rejects everything else, with a specific code', () => {
  it.each([
    ['empty', new Uint8Array(0), 'EMPTY'],
    ['a PNG', new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(40).fill(0)]), 'NOT_GLB'],
    ['glTF 1', buildGlb(sampleGltf(), undefined, { version: 1 }), 'BAD_VERSION'],
    ['truncated', sampleGlb().subarray(0, 60), 'BAD_LENGTH'],
    ['length lies', buildGlb(sampleGltf(), undefined, { lengthDelta: 4 }), 'BAD_LENGTH'],
    ['glTF 1.0 asset', buildGlb(sampleGltf({ asset: { version: '1.0' } })), 'NOT_GLTF2'],
    [
      'an external buffer',
      buildGlb(sampleGltf({ buffers: [{ byteLength: 36, uri: 'https://evil.example/b.bin' }] })),
      'EXTERNAL_RESOURCE',
    ],
    ['an external image', sampleGlb({ images: [{ uri: 'tex.png' }] }), 'EXTERNAL_RESOURCE'],
    [
      'Draco',
      sampleGlb({ extensionsRequired: ['KHR_draco_mesh_compression'] }),
      'UNSUPPORTED_COMPRESSION',
    ],
    ['KTX2', sampleGlb({ extensionsRequired: ['KHR_texture_basisu'] }), 'UNSUPPORTED_COMPRESSION'],
    [
      'an unknown required ext',
      sampleGlb({ extensionsRequired: ['ACME_magic'] }),
      'UNSUPPORTED_EXTENSION',
    ],
    ['no mesh', sampleGlb({ meshes: [] }), 'NO_MESH'],
  ])('%s → %s', (_label, bytes, code) => {
    expect(fail(bytes as Uint8Array)).toBe(code);
  });

  it('rejects a corrupt JSON chunk and a non-JSON first chunk', () => {
    const bad = sampleGlb();
    bad[20] = 0xff; // invalid UTF-8 start byte
    expect(fail(bad)).toBe('BAD_JSON');
    const wrongType = sampleGlb();
    new DataView(wrongType.buffer).setUint32(16, 0x004e4942, true);
    expect(fail(wrongType)).toBe('BAD_JSON_CHUNK');
  });

  it('rejects a second chunk that is not BIN or runs past the end', () => {
    const g = sampleGlb();
    const v = new DataView(g.buffer);
    const jsonLen = v.getUint32(12, true);
    const binHeader = 20 + jsonLen;
    v.setUint32(binHeader + 4, 0x12345678, true);
    expect(fail(g)).toBe('BAD_BIN_CHUNK');
    const g2 = sampleGlb();
    new DataView(g2.buffer).setUint32(binHeader, 9999, true);
    expect(fail(g2)).toBe('BAD_BIN_CHUNK');
  });

  it('rejects over the hard vertex ceiling and over the byte cap', () => {
    const g = sampleGltf();
    (g.accessors as Array<{ count: number }>)[0].count = MODEL3D_MAX_VERTICES + 1;
    expect(fail(buildGlb(g, new Uint8Array(36)))).toBe('TOO_COMPLEX');
    expect(validateGlb(sampleGlb(), 50)).toMatchObject({ ok: false, code: 'TOO_LARGE' });
    expect(MODEL3D_MAX_BYTES).toBe(15 * 1024 * 1024);
  });

  it('every code has an English and an Arabic message', () => {
    for (const code of ['EMPTY', 'NOT_GLB', 'UNSUPPORTED_COMPRESSION', 'NOT_USDZ'] as const) {
      expect(model3dErrorMessage(code, 'en')).toMatch(/[a-z]/i);
      expect(model3dErrorMessage(code, 'ar')).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('validateUsdz', () => {
  it('accepts a stored zip whose first entry is a USD layer', () => {
    expect(validateUsdz(buildUsdz('model.usdc'))).toEqual({ ok: true });
    expect(validateUsdz(buildUsdz('scene.usda'))).toEqual({ ok: true });
  });
  it.each([
    ['a deflated entry', buildUsdz('model.usdc', 8)],
    ['a non-USD first entry', buildUsdz('readme.txt')],
    ['not a zip', buildUsdz('model.usdc', 0, 0x46546c67)],
    ['too short', new Uint8Array(10)],
  ])('rejects %s', (_l, bytes) => {
    expect(validateUsdz(bytes)).toEqual({ ok: false, code: 'NOT_USDZ' });
  });
});

describe('binding + update schemas', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  it('a material binding needs a hex colour; colours are lower-cased', () => {
    const ok = model3dBindingsBodySchema.parse({
      bindings: [
        {
          optionValueId: id,
          kind: 'material',
          target: 'Band',
          color: '#FFC356',
          metalness: 1,
          roughness: 0.25,
        },
      ],
    });
    expect(ok.bindings[0].color).toBe('#ffc356');
    expect(() =>
      model3dBindingsBodySchema.parse({
        bindings: [{ optionValueId: id, kind: 'material', target: 'Band' }],
      })
    ).toThrow();
    expect(() =>
      model3dBindingsBodySchema.parse({
        bindings: [{ optionValueId: id, kind: 'material', target: 'Band', color: 'token:primary' }],
      })
    ).toThrow();
  });
  it('rejects duplicates, two glTF variants on one value, and metalness out of range', () => {
    const b = { optionValueId: id, kind: 'material', target: 'Band', color: '#000000' };
    expect(() => model3dBindingsBodySchema.parse({ bindings: [b, b] })).toThrow();
    expect(() =>
      model3dBindingsBodySchema.parse({
        bindings: [
          { optionValueId: id, kind: 'gltf_variant', target: 'Gold' },
          { optionValueId: id, kind: 'gltf_variant', target: 'Silver' },
        ],
      })
    ).toThrow();
    expect(() => model3dBindingsBodySchema.parse({ bindings: [{ ...b, metalness: 2 }] })).toThrow();
  });
  it('update accepts only null for usdzUrl and refuses unknown keys', () => {
    expect(model3dUpdateSchema.parse({ usdzUrl: null })).toEqual({ usdzUrl: null });
    expect(() => model3dUpdateSchema.parse({ usdzUrl: 'https://x.test/a.usdz' })).toThrow();
    expect(() => model3dUpdateSchema.parse({ modelUrl: 'https://x.test/a.glb' })).toThrow();
  });
});

describe('resolveModel3dLook — partial selections', () => {
  const bindings: PublicModel3dBinding[] = [
    {
      optionName: 'Metal',
      value: 'Gold',
      kind: 'material',
      target: 'Band',
      color: '#ffc356',
      metalness: 1,
      roughness: 0.25,
    },
    {
      optionName: 'Metal',
      value: 'Rose',
      kind: 'material',
      target: 'Band',
      color: '#f2b49b',
      metalness: 1,
      roughness: 0.25,
    },
    {
      optionName: 'Stone',
      value: 'Ruby',
      kind: 'material',
      target: 'Band',
      color: '#aa0000',
      metalness: 0,
      roughness: 0.5,
    },
    {
      optionName: 'Finish',
      value: 'Matte',
      kind: 'gltf_variant',
      target: 'matte',
      color: null,
      metalness: null,
      roughness: null,
    },
  ];
  it('applies a binding as soon as its option is picked, before the rest', () => {
    const look = resolveModel3dLook(bindings, { Metal: 'Gold' }, ['Metal', 'Size']);
    expect(look).toEqual({
      materials: { Band: { color: '#ffc356', metalness: 1, roughness: 0.25 } },
      gltfVariant: null,
    });
  });
  it('nothing picked = the file default', () => {
    expect(resolveModel3dLook(bindings, {})).toEqual({ materials: {}, gltfVariant: null });
  });
  it('the later option wins a contested material, regardless of binding order', () => {
    const look = resolveModel3dLook(bindings, { Metal: 'Rose', Stone: 'Ruby' }, ['Stone', 'Metal']);
    expect(look.materials.Band.color).toBe('#f2b49b');
  });
  it('selects a glTF variant and exposes swatch colours for pills', () => {
    expect(resolveModel3dLook(bindings, { Finish: 'Matte' }).gltfVariant).toBe('matte');
    expect(model3dSwatchColor(bindings, 'Metal', 'Rose')).toBe('#f2b49b');
    expect(model3dSwatchColor(bindings, 'Finish', 'Matte')).toBeUndefined();
  });
});
