/**
 * Product 3D models — format validation, limits and the variant binding
 * resolver. Pure (no DOM, no Node APIs beyond TextDecoder), so the API runs it
 * as the upload gate and the admin runs the SAME code as a pre-check before it
 * sends 15 MB over a phone connection. The server copy is the gate; the client
 * copy is only feedback. See docs/plans/2026-10-07-product-3d-viewer.md.
 */
import { z } from 'zod/v3';

/** Hard cap for one uploaded model or USDZ file (bytes). */
export const MODEL3D_MAX_BYTES = 15 * 1024 * 1024;
/** Above this the admin shows a "large file" warning (still accepted). */
export const MODEL3D_WARN_BYTES = 8 * 1024 * 1024;
/** Vertex ceiling: past this a phone cannot render the model smoothly. */
export const MODEL3D_MAX_VERTICES = 2_000_000;
export const MODEL3D_WARN_VERTICES = 500_000;
export const MODEL3D_MAX_MATERIALS = 512;
export const MODEL3D_MAX_MESHES = 4096;

/**
 * Extensions a model may REQUIRE. Everything here is decoded by three.js's
 * GLTFLoader with no extra download (meshopt's decoder is bundled JS, WebP is
 * decoded by the browser). Draco and KTX2/Basis need decoder wasm we do not
 * host yet (Phase 2) — a file that requires them is rejected with a message
 * that says how to re-export it (Ruling R-EBDA-3D-3).
 */
export const MODEL3D_SUPPORTED_REQUIRED_EXTENSIONS: readonly string[] = [
  'KHR_materials_clearcoat',
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_iridescence',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_materials_volume',
  'KHR_materials_anisotropy',
  'KHR_materials_dispersion',
  'KHR_materials_variants',
  'KHR_texture_transform',
  'KHR_mesh_quantization',
  'EXT_meshopt_compression',
  'EXT_texture_webp',
];

/** Extensions we reject on purpose, with a dedicated error code. */
export const MODEL3D_UNSUPPORTED_COMPRESSION = [
  'KHR_draco_mesh_compression',
  'KHR_texture_basisu',
] as const;

export type Model3dErrorCode =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'NOT_GLB'
  | 'BAD_VERSION'
  | 'BAD_LENGTH'
  | 'BAD_JSON_CHUNK'
  | 'BAD_BIN_CHUNK'
  | 'BAD_JSON'
  | 'NOT_GLTF2'
  | 'EXTERNAL_RESOURCE'
  | 'UNSUPPORTED_COMPRESSION'
  | 'UNSUPPORTED_EXTENSION'
  | 'NO_MESH'
  | 'TOO_COMPLEX'
  | 'NOT_USDZ';

export interface Model3dMaterial {
  index: number;
  name: string;
}

export interface Model3dStats {
  vertices: number;
  meshes: number;
  materials: number;
  textures: number;
  extensionsUsed: string[];
}

export type Model3dWarning = 'LARGE_FILE' | 'MANY_VERTICES';

export type GlbValidation =
  | {
      ok: true;
      materials: Model3dMaterial[];
      gltfVariants: string[];
      stats: Model3dStats;
      warnings: Model3dWarning[];
    }
  | { ok: false; code: Model3dErrorCode; detail?: string };

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

function fail(code: Model3dErrorCode, detail?: string): GlbValidation {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Validate a binary glTF 2.0 (`.glb`) byte buffer and extract what the admin
 * mapping UI and the stats line need. Never throws: every malformed shape
 * returns `{ ok: false, code }`.
 */
export function validateGlb(bytes: Uint8Array, maxBytes = MODEL3D_MAX_BYTES): GlbValidation {
  if (!bytes || bytes.byteLength === 0) return fail('EMPTY');
  if (bytes.byteLength > maxBytes) return fail('TOO_LARGE');
  // 12-byte header + one 8-byte chunk header at minimum.
  if (bytes.byteLength < 20) return fail('NOT_GLB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return fail('NOT_GLB');
  if (view.getUint32(4, true) !== 2) return fail('BAD_VERSION');
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.byteLength) return fail('BAD_LENGTH');

  // Chunk 0 must be JSON.
  const jsonLength = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== CHUNK_JSON) return fail('BAD_JSON_CHUNK');
  if (jsonLength === 0 || jsonLength % 4 !== 0 || 20 + jsonLength > bytes.byteLength) {
    return fail('BAD_JSON_CHUNK');
  }
  let offset = 20 + jsonLength;
  // Optional chunk 1 must be BIN, and must fit exactly inside the file.
  if (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return fail('BAD_BIN_CHUNK');
    const binLength = view.getUint32(offset, true);
    const binType = view.getUint32(offset + 4, true);
    if (binType !== CHUNK_BIN) return fail('BAD_BIN_CHUNK');
    if (offset + 8 + binLength > bytes.byteLength) return fail('BAD_BIN_CHUNK');
    offset += 8 + binLength;
  }

  let json: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(20, 20 + jsonLength)
    );
    json = JSON.parse(text);
  } catch {
    return fail('BAD_JSON');
  }
  if (!isRecord(json)) return fail('BAD_JSON');
  const asset = json.asset;
  if (!isRecord(asset) || typeof asset.version !== 'string' || !asset.version.startsWith('2.')) {
    return fail('NOT_GLTF2');
  }

  // Self-contained only: an external buffer/image URI would not resolve from
  // our bucket, and a remote one would make every shopper's browser call a
  // host the merchant (or anyone who edited the file) chose.
  for (const b of arr(json.buffers)) {
    if (isRecord(b) && b.uri !== undefined) return fail('EXTERNAL_RESOURCE', 'buffer');
  }
  for (const img of arr(json.images)) {
    if (isRecord(img) && img.uri !== undefined) return fail('EXTERNAL_RESOURCE', 'image');
  }

  const required = arr(json.extensionsRequired).filter((e): e is string => typeof e === 'string');
  for (const ext of required) {
    if ((MODEL3D_UNSUPPORTED_COMPRESSION as readonly string[]).includes(ext)) {
      return fail('UNSUPPORTED_COMPRESSION', ext);
    }
    if (!MODEL3D_SUPPORTED_REQUIRED_EXTENSIONS.includes(ext)) {
      return fail('UNSUPPORTED_EXTENSION', ext);
    }
  }

  const meshes = arr(json.meshes);
  if (meshes.length === 0) return fail('NO_MESH');
  const materialsRaw = arr(json.materials);
  if (materialsRaw.length > MODEL3D_MAX_MATERIALS || meshes.length > MODEL3D_MAX_MESHES) {
    return fail('TOO_COMPLEX', 'counts');
  }

  // Vertices = sum of POSITION accessor counts, each accessor counted ONCE
  // (primitives may share one; counting it per primitive over-reports).
  const accessors = arr(json.accessors);
  const seenPositions = new Set<number>();
  let vertices = 0;
  for (const mesh of meshes) {
    if (!isRecord(mesh)) continue;
    for (const prim of arr(mesh.primitives)) {
      if (!isRecord(prim) || !isRecord(prim.attributes)) continue;
      const pos = prim.attributes.POSITION;
      if (typeof pos !== 'number' || seenPositions.has(pos)) continue;
      seenPositions.add(pos);
      const acc = accessors[pos];
      if (isRecord(acc) && typeof acc.count === 'number' && acc.count > 0) vertices += acc.count;
    }
  }
  if (vertices > MODEL3D_MAX_VERTICES) return fail('TOO_COMPLEX', 'vertices');

  const materials: Model3dMaterial[] = materialsRaw.map((m, index) => {
    const raw = isRecord(m) && typeof m.name === 'string' ? m.name.trim() : '';
    return { index, name: (raw || `Material ${index + 1}`).slice(0, 100) };
  });

  const extensions = isRecord(json.extensions) ? json.extensions : {};
  const variantsExt = extensions.KHR_materials_variants;
  const gltfVariants = isRecord(variantsExt)
    ? arr(variantsExt.variants)
        .map(v => (isRecord(v) && typeof v.name === 'string' ? v.name.trim().slice(0, 100) : ''))
        .filter(Boolean)
    : [];

  const warnings: Model3dWarning[] = [];
  if (bytes.byteLength > MODEL3D_WARN_BYTES) warnings.push('LARGE_FILE');
  if (vertices > MODEL3D_WARN_VERTICES) warnings.push('MANY_VERTICES');

  return {
    ok: true,
    materials,
    gltfVariants,
    stats: {
      vertices,
      meshes: meshes.length,
      materials: materialsRaw.length,
      textures: arr(json.textures).length,
      extensionsUsed: arr(json.extensionsUsed)
        .filter((e): e is string => typeof e === 'string')
        .slice(0, 50),
    },
    warnings,
  };
}

export type UsdzValidation = { ok: true } | { ok: false; code: Model3dErrorCode };

/**
 * USDZ = an uncompressed ZIP whose FIRST entry is the USD layer
 * (`.usdc`/`.usda`/`.usd`). Checks the first local file header only — enough
 * to refuse a renamed image/zip/anything else; iOS Quick Look is the real
 * consumer and refuses a broken one on its own.
 */
export function validateUsdz(bytes: Uint8Array, maxBytes = MODEL3D_MAX_BYTES): UsdzValidation {
  if (!bytes || bytes.byteLength === 0) return { ok: false, code: 'EMPTY' };
  if (bytes.byteLength > maxBytes) return { ok: false, code: 'TOO_LARGE' };
  if (bytes.byteLength < 30) return { ok: false, code: 'NOT_USDZ' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50) return { ok: false, code: 'NOT_USDZ' };
  const method = view.getUint16(8, true);
  if (method !== 0) return { ok: false, code: 'NOT_USDZ' };
  const nameLength = view.getUint16(26, true);
  if (nameLength === 0 || 30 + nameLength > bytes.byteLength)
    return { ok: false, code: 'NOT_USDZ' };
  let name = '';
  for (let i = 0; i < nameLength; i++) name += String.fromCharCode(bytes[30 + i]);
  if (!/\.usd[ac]?$/i.test(name)) return { ok: false, code: 'NOT_USDZ' };
  return { ok: true };
}

/** Bilingual merchant-facing message for a validation code. */
export function model3dErrorMessage(code: Model3dErrorCode, locale: 'en' | 'ar'): string {
  const mb = Math.round(MODEL3D_MAX_BYTES / 1024 / 1024);
  const m: Record<Model3dErrorCode, [string, string]> = {
    EMPTY: ['The file is empty.', 'الملف فاضي.'],
    TOO_LARGE: [`The file is larger than ${mb} MB.`, `الملف أكبر من ${mb} ميجا.`],
    NOT_GLB: [
      'This is not a .glb file. Export your model as binary glTF (.glb).',
      'ده مش ملف ‎.glb‎. صدّر الموديل بصيغة glTF الثنائية (‎.glb‎).',
    ],
    BAD_VERSION: ['Only glTF 2.0 files are supported.', 'مدعوم بس glTF 2.0.'],
    BAD_LENGTH: ['The file looks truncated or corrupted.', 'الملف شكله ناقص أو بايظ.'],
    BAD_JSON_CHUNK: ['The file is corrupted (JSON chunk).', 'الملف بايظ (جزء JSON).'],
    BAD_BIN_CHUNK: ['The file is corrupted (binary chunk).', 'الملف بايظ (الجزء الثنائي).'],
    BAD_JSON: ['The file is corrupted (unreadable JSON).', 'الملف بايظ (JSON مش مقروء).'],
    NOT_GLTF2: ['Only glTF 2.0 files are supported.', 'مدعوم بس glTF 2.0.'],
    EXTERNAL_RESOURCE: [
      'The model points to outside files. Export one self-contained .glb with textures embedded.',
      'الموديل بيشاور على ملفات برّه. صدّر ملف ‎.glb‎ واحد والخامات جواه.',
    ],
    UNSUPPORTED_COMPRESSION: [
      'Draco/KTX2 compression is not supported yet. Re-export with meshopt + WebP (see the help article).',
      'ضغط Draco/KTX2 مش مدعوم لسه. صدّر تاني بـ meshopt و WebP (شوف مقالة المساعدة).',
    ],
    UNSUPPORTED_EXTENSION: [
      'The model needs a glTF extension we do not support.',
      'الموديل محتاج امتداد glTF مش مدعوم عندنا.',
    ],
    NO_MESH: ['The file has no 3D mesh in it.', 'الملف مفيهوش أي مجسم.'],
    TOO_COMPLEX: [
      'The model is too detailed for phones. Simplify it (see the help article).',
      'الموديل تفاصيله كتير على الموبايل. بسّطه (شوف مقالة المساعدة).',
    ],
    NOT_USDZ: ['This is not a valid .usdz file.', 'ده مش ملف ‎.usdz‎ سليم.'],
  };
  return m[code][locale === 'ar' ? 1 : 0];
}

// ─── Variant bindings ────────────────────────────────────────────────────────

/**
 * Metal finishes for the jewellery presets — PBR base colours (linear-ish sRGB
 * hex as merchants pick them), metalness 1. Custom colours use metalness 0.
 */
export const MODEL3D_METAL_PRESETS = {
  gold: { color: '#ffc356', metalness: 1, roughness: 0.25 },
  white_gold: { color: '#e8e6df', metalness: 1, roughness: 0.25 },
  rose_gold: { color: '#f2b49b', metalness: 1, roughness: 0.25 },
  silver: { color: '#f5f5f5', metalness: 1, roughness: 0.2 },
  platinum: { color: '#d6d2c9', metalness: 1, roughness: 0.3 },
} as const;
export type Model3dMetalPreset = keyof typeof MODEL3D_METAL_PRESETS;

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform(s => s.toLowerCase());
const unit = z.number().min(0).max(1);

export const model3dBindingSchema = z
  .object({
    optionValueId: z.string().uuid(),
    kind: z.enum(['material', 'gltf_variant']),
    target: z.string().trim().min(1).max(100),
    color: hexColor.nullable().optional(),
    metalness: unit.nullable().optional(),
    roughness: unit.nullable().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.kind === 'material' && !b.color) {
      ctx.addIssue({
        code: 'custom',
        path: ['color'],
        message: 'A material binding needs a colour',
      });
    }
    if (b.kind === 'gltf_variant' && (b.color || b.metalness != null || b.roughness != null)) {
      ctx.addIssue({ code: 'custom', message: 'A glTF-variant binding carries no colour' });
    }
  });
export type Model3dBindingInput = z.infer<typeof model3dBindingSchema>;

export const model3dBindingsBodySchema = z
  .object({ bindings: z.array(model3dBindingSchema).max(200) })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    const variantPerValue = new Set<string>();
    body.bindings.forEach((b, i) => {
      const key = `${b.optionValueId}|${b.kind}|${b.target}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['bindings', i], message: 'Duplicate binding' });
      }
      seen.add(key);
      if (b.kind === 'gltf_variant') {
        if (variantPerValue.has(b.optionValueId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['bindings', i],
            message: 'One glTF variant per option value',
          });
        }
        variantPerValue.add(b.optionValueId);
      }
    });
  });

export const model3dUpdateSchema = z
  .object({
    altText: z.string().trim().max(250).nullable().optional(),
    altTextAr: z.string().trim().max(250).nullable().optional(),
    arEnabled: z.boolean().optional(),
    posterUrl: z.string().url().max(2048).nullable().optional(),
    /** Only `null` is accepted: removes the uploaded USDZ (upload goes through POST /usdz). */
    usdzUrl: z.null().optional(),
  })
  .strict();
export type Model3dUpdateInput = z.infer<typeof model3dUpdateSchema>;

/** A binding as the storefront receives it — keyed by option NAME + value. */
export interface PublicModel3dBinding {
  optionName: string;
  value: string;
  kind: 'material' | 'gltf_variant';
  target: string;
  color: string | null;
  metalness: number | null;
  roughness: number | null;
}

export interface PublicModel3d {
  modelUrl: string;
  usdzUrl: string | null;
  posterUrl: string | null;
  altText: string | null;
  altTextAr: string | null;
  arEnabled: boolean;
  bindings: PublicModel3dBinding[];
}

/** What the viewer should apply right now. */
export interface ActiveModel3dLook {
  /** material name → finish */
  materials: Record<string, { color: string; metalness: number | null; roughness: number | null }>;
  /** glTF KHR_materials_variants name, or null for the file's default look */
  gltfVariant: string | null;
}

/**
 * Resolve the shopper's (possibly PARTIAL) option selection into the finish
 * the viewer applies. Bindings follow option order: when two picked values
 * both bind the same material, the later option wins — deterministic, never
 * a race.
 */
export function resolveModel3dLook(
  bindings: readonly PublicModel3dBinding[],
  selected: Readonly<Record<string, string>>,
  optionOrder: readonly string[] = []
): ActiveModel3dLook {
  const rank = (name: string) => {
    const i = optionOrder.indexOf(name);
    return i === -1 ? optionOrder.length : i;
  };
  const active = bindings
    .filter(b => selected[b.optionName] !== undefined && selected[b.optionName] === b.value)
    .sort((a, b) => rank(a.optionName) - rank(b.optionName));
  const look: ActiveModel3dLook = { materials: {}, gltfVariant: null };
  for (const b of active) {
    if (b.kind === 'gltf_variant') look.gltfVariant = b.target;
    else if (b.color) {
      look.materials[b.target] = {
        color: b.color,
        metalness: b.metalness,
        roughness: b.roughness,
      };
    }
  }
  return look;
}

/** Swatch colour for an option pill, when that value carries a colour binding. */
export function model3dSwatchColor(
  bindings: readonly PublicModel3dBinding[],
  optionName: string,
  value: string
): string | undefined {
  return bindings.find(
    b => b.kind === 'material' && b.optionName === optionName && b.value === value && b.color
  )?.color as string | undefined;
}
