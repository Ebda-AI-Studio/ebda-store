// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  IMAGE_UPLOAD_ACCEPTED_TYPES,
  IMAGE_UPLOAD_BATCH_MAX,
  IMAGE_UPLOAD_MAX_BYTES,
} from '@ebda/shared';
import { chunk, useImageUpload } from '../../apps/admin/src/hooks/useImageUpload';
import { ERROR_EN } from '../../apps/admin/src/lib/error-messages';
import { partitionImageFiles } from '../../apps/admin/src/components/image-upload/accept-files';

vi.mock('next-intl', () => {
  // Interpolating stub: the key plus its values, so a test can see which files were named.
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});

/**
 * Per-request server behaviour for the FakeXhr below: given the names in one request,
 * answer 200 (URL per name) or a 400 with the refused indexes, as POST /uploads/images does.
 */
let serverRefuses: (names: string[]) => number[] | 'error' | null = () => null;

/** One fake XHR per request: answers 200 with a URL per file NAME, in the order sent. */
const sent: string[][] = [];
class FakeXhr {
  status = 0;
  responseText = '';
  timeout = 0;
  upload = { addEventListener: () => undefined };
  private listeners: Record<string, () => void> = {};
  addEventListener(type: string, fn: () => void) {
    this.listeners[type] = fn;
  }
  open() {}
  setRequestHeader() {}
  send(body: FormData) {
    const names = (body.getAll('files') as File[]).map(f => f.name);
    sent.push(names);
    const refused = serverRefuses(names);
    if (names.length > IMAGE_UPLOAD_BATCH_MAX) {
      this.status = 400;
      this.responseText = JSON.stringify({
        success: false,
        error: { code: 'LIMIT_FILE_COUNT', message: 'Too many files' },
      });
    } else if (refused === 'error') {
      this.status = 503;
      this.responseText = JSON.stringify({
        success: false,
        error: { code: 'STORAGE_NOT_CONFIGURED', message: 'Storage is down' },
      });
    } else if (refused && refused.length > 0) {
      this.status = 400;
      this.responseText = JSON.stringify({
        success: false,
        error: {
          code: 'INVALID_IMAGE_CONTENT',
          message: 'The file is not a JPEG, PNG, GIF or WebP image',
          details: { invalidIndexes: refused },
        },
      });
    } else {
      this.status = 200;
      this.responseText = JSON.stringify({
        success: true,
        data: { files: names.map(n => ({ url: `https://cdn/${n}` })) },
      });
    }
    setTimeout(() => this.listeners.load?.(), 0);
  }
}

describe('gallery upload batching (B0-45 → FU46-6)', () => {
  it('the shared ceiling is 4 files of 10 MB', () => {
    expect(IMAGE_UPLOAD_BATCH_MAX).toBe(4);
    expect(IMAGE_UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
  it('chunks keep selection order and never exceed the batch size', () => {
    expect(chunk([1, 2, 3, 4, 5], 4)).toEqual([[1, 2, 3, 4], [5]]);
    expect(chunk([1, 2, 3, 4], 4)).toEqual([[1, 2, 3, 4]]);
    expect(chunk([], 4)).toEqual([]);
  });
});

describe('useImageUpload.uploadMulti with more files than one batch (Review Focus)', () => {
  afterEach(() => {
    sent.length = 0;
    serverRefuses = () => null;
    vi.unstubAllGlobals();
  });

  const pick = (...names: string[]) =>
    names.map(n => new File([new Uint8Array([1])], n, { type: 'image/png' }));

  async function run(files: File[]) {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { result } = renderHook(() => useImageUpload());
    let out: Awaited<ReturnType<typeof result.current.uploadMulti>> | null = null;
    await act(async () => {
      out = await result.current.uploadMulti(files, 'products', 'store-1');
    });
    return { out: out!, result };
  }

  it('second batch refuses its only file: the first 4 are kept, the refused one is named', async () => {
    serverRefuses = names => (names[0] === 'e.png' ? [0] : null);
    const { out, result } = await run(pick('a.png', 'b.png', 'c.png', 'd.png', 'e.png'));
    expect(out.urls).toEqual(['a', 'b', 'c', 'd'].map(n => `https://cdn/${n}.png`));
    expect(out.failed.map(f => f.name)).toEqual(['e.png']);
    expect(out.failed[0].reason).toBe('The file is not a JPEG, PNG, GIF or WebP image');
    expect(result.current.error).toContain('e.png');
    expect(result.current.error).not.toContain('a.png');
    expect(result.current.uploading).toBe(false);
    expect(result.current.progress).toBe(0);
  });

  it('a refused file does not sink its batch-mates: they are re-sent without it', async () => {
    // Batch 2 is [e, f]; the server refuses f (index 1) → e is re-sent alone and kept.
    serverRefuses = names => (names.includes('f.png') ? [names.indexOf('f.png')] : null);
    const { out, result } = await run(pick('a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png'));
    expect(sent).toEqual([['a.png', 'b.png', 'c.png', 'd.png'], ['e.png', 'f.png'], ['e.png']]);
    expect(out.urls).toEqual(['a', 'b', 'c', 'd', 'e'].map(n => `https://cdn/${n}.png`));
    expect(out.failed.map(f => f.name)).toEqual(['f.png']);
    expect(result.current.error).toContain('f.png');
  });

  it('a batch that fails for a non-file reason names all of its files and keeps the rest', async () => {
    serverRefuses = names => (names[0] === 'e.png' ? 'error' : null);
    const { out, result } = await run(
      pick('a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png', 'g.png', 'h.png', 'i.png')
    );
    expect(out.urls).toEqual(['a', 'b', 'c', 'd', 'i'].map(n => `https://cdn/${n}.png`));
    expect(out.failed.map(f => f.name)).toEqual(['e.png', 'f.png', 'g.png', 'h.png']);
    // a 503's server text is never shown; the fixed sentence is (Ruling ADMIN-ERR-1)
    expect(out.failed[0].reason).toBe(ERROR_EN.SERVER_ERROR);
    expect(result.current.error).toContain('h.png');
  });

  it('5 selected images: 2 requests (4 + 1), all 5 URLs back in selection order', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const files = ['a', 'b', 'c', 'd', 'e'].map(n => new File([new Uint8Array([1])], `${n}.png`));
    const { result } = renderHook(() => useImageUpload());
    let out: Awaited<ReturnType<typeof result.current.uploadMulti>> | null = null;
    await act(async () => {
      out = await result.current.uploadMulti(files, 'products', 'store-1');
    });
    expect(sent).toEqual([['a.png', 'b.png', 'c.png', 'd.png'], ['e.png']]);
    expect(out!.urls).toEqual(['a', 'b', 'c', 'd', 'e'].map(n => `https://cdn/${n}.png`));
    expect(out!.failed).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

describe('the admin picker accepts only what the server accepts (FU46 I-1a)', () => {
  it('the accept list is the four formats the server sniffs', () => {
    expect([...IMAGE_UPLOAD_ACCEPTED_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ]);
  });

  it('refuses HEIC, SVG, ICO and oversize files by name, keeps the rest in order', () => {
    const f = (name: string, type: string, size = 10) =>
      new File([new Uint8Array(size)], name, { type });
    const big = new File([new Uint8Array(1)], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: IMAGE_UPLOAD_MAX_BYTES + 1 });
    const { accepted, refused } = partitionImageFiles([
      f('a.jpg', 'image/jpeg'),
      f('b.heic', 'image/heic'),
      f('c.png', 'image/png'),
      f('d.svg', 'image/svg+xml'),
      f('e.ico', 'image/x-icon'),
      big,
      f('g.webp', 'image/webp'),
      f('h.gif', 'image/gif'),
    ]);
    expect(accepted.map(x => x.name)).toEqual(['a.jpg', 'c.png', 'g.webp', 'h.gif']);
    expect(refused).toEqual([
      { name: 'b.heic', reason: 'type' },
      { name: 'd.svg', reason: 'type' },
      { name: 'e.ico', reason: 'type' },
      { name: 'huge.jpg', reason: 'size' },
    ]);
  });
});
