// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { IMAGE_UPLOAD_BATCH_MAX, IMAGE_UPLOAD_MAX_BYTES } from '@ebda/shared';
import { chunk, useImageUpload } from '../../apps/admin/src/hooks/useImageUpload';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});

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
    this.status = names.length > IMAGE_UPLOAD_BATCH_MAX ? 400 : 200;
    this.responseText = JSON.stringify(
      this.status === 200
        ? { success: true, data: { files: names.map(n => ({ url: `https://cdn/${n}` })) } }
        : { success: false, error: { code: 'LIMIT_FILE_COUNT', message: 'Too many files' } }
    );
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
    vi.unstubAllGlobals();
  });

  it('5 selected images: 2 requests (4 + 1), all 5 URLs back in selection order', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const files = ['a', 'b', 'c', 'd', 'e'].map(n => new File([new Uint8Array([1])], `${n}.png`));
    const { result } = renderHook(() => useImageUpload());
    let urls: string[] | null = null;
    await act(async () => {
      urls = await result.current.uploadMulti(files, 'products', 'store-1');
    });
    expect(sent).toEqual([['a.png', 'b.png', 'c.png', 'd.png'], ['e.png']]);
    expect(urls).toEqual(['a', 'b', 'c', 'd', 'e'].map(n => `https://cdn/${n}.png`));
  });
});
