/**
 * Build binary glTF (.glb) and USDZ byte buffers in memory for the 3D-model
 * tests — no binary fixtures in the repo, every malformed shape is one edit.
 */
export function buildGlb(
  json: Record<string, unknown>,
  bin?: Uint8Array,
  opts: { version?: number; magic?: number; lengthDelta?: number } = {}
): Uint8Array {
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = Math.ceil(enc.length / 4) * 4;
  const jsonChunk = new Uint8Array(jsonLen).fill(0x20);
  jsonChunk.set(enc);
  const binLen = bin ? Math.ceil(bin.length / 4) * 4 : 0;
  const total = 12 + 8 + jsonLen + (bin ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, opts.magic ?? 0x46546c67, true);
  v.setUint32(4, opts.version ?? 2, true);
  v.setUint32(8, total + (opts.lengthDelta ?? 0), true);
  v.setUint32(12, jsonLen, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  if (bin) {
    const o = 20 + jsonLen;
    v.setUint32(o, binLen, true);
    v.setUint32(o + 4, 0x004e4942, true);
    out.set(bin, o + 8);
  }
  return out;
}

/** A minimal valid one-triangle model with two named materials. */
export function sampleGltf(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset: { version: '2.0', generator: 'test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
    materials: [{ name: 'Band' }, { name: 'Stone' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    ...extra,
  };
}

export function sampleGlb(extra: Record<string, unknown> = {}): Uint8Array {
  return buildGlb(sampleGltf(extra), new Uint8Array(36));
}

/** First local-file header of a stored ZIP whose first entry is `name`. */
export function buildUsdz(name = 'model.usdc', method = 0, magic = 0x04034b50): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const out = new Uint8Array(30 + nameBytes.length + 64);
  const v = new DataView(out.buffer);
  v.setUint32(0, magic, true);
  v.setUint16(4, 20, true);
  v.setUint16(8, method, true);
  v.setUint16(26, nameBytes.length, true);
  out.set(nameBytes, 30);
  return out;
}
