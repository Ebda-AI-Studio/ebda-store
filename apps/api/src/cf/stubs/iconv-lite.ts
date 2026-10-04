// body-parser / raw-body decode request bodies with iconv-lite, whose `browser`
// field nulls ./streams and breaks under esbuild (experiment B3). Workers have
// TextDecoder; the API only receives UTF-8 / latin1 JSON, urlencoded and text.
const label = (enc: string): string => {
  const e = enc.toLowerCase().replace(/_/g, '-');
  return e === 'utf8' ? 'utf-8' : e === 'binary' ? 'latin1' : e;
};

export function encodingExists(enc: string): boolean {
  try {
    new TextDecoder(label(enc));
    return true;
  } catch {
    return false;
  }
}

export function decode(buf: Uint8Array, enc: string): string {
  return new TextDecoder(label(enc)).decode(buf);
}

export function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function getDecoder(enc: string): {
  write(chunk: Uint8Array): string;
  end(): string | undefined;
} {
  const d = new TextDecoder(label(enc));
  return {
    write: chunk => d.decode(chunk, { stream: true }),
    end: () => d.decode() || undefined,
  };
}

export default { encodingExists, decode, encode, getDecoder };
