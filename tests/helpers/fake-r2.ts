/** In-memory R2 with etag preconditions (the subset the CI sink and the erasure surfaces use). */
export class FakeR2 {
  objs = new Map<string, { body: Uint8Array; etag: string }>();
  n = 0;
  failPut = false;
  async get(key: string) {
    const o = this.objs.get(key);
    if (!o) return null;
    return {
      etag: o.etag,
      text: async () => new TextDecoder().decode(o.body),
      arrayBuffer: async () =>
        o.body.buffer.slice(
          o.body.byteOffset,
          o.body.byteOffset + o.body.byteLength
        ) as ArrayBuffer,
    };
  }
  async put(
    key: string,
    value: string | Uint8Array | ArrayBuffer,
    opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }
  ) {
    if (this.failPut) throw new Error('r2 down');
    const cur = this.objs.get(key);
    if (opts?.onlyIf?.etagDoesNotMatch === '*' && cur) return null;
    if (opts?.onlyIf?.etagMatches && cur?.etag !== opts.onlyIf.etagMatches) return null;
    const body =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    this.objs.set(key, { body, etag: `e${++this.n}` });
    return {};
  }
  async delete(keys: string | string[]) {
    for (const k of ([] as string[]).concat(keys)) this.objs.delete(k);
  }
  async list(o?: { prefix?: string }) {
    return {
      objects: [...this.objs.keys()]
        .filter(k => k.startsWith(o?.prefix ?? ''))
        .map(key => ({ key })),
      truncated: false,
    };
  }
  keys(prefix = '') {
    return [...this.objs.keys()].filter(k => k.startsWith(prefix));
  }
}
