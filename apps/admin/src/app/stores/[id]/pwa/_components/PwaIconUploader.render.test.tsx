// @vitest-environment jsdom
/**
 * P2 on PR #1977: `mergeIconFields` fixed #1915 (the upload response
 * wholesale-replacing unsaved edits) but merged against the `settings` the
 * drop handler CLOSED OVER when it was created. An edit the merchant made in
 * a sibling section WHILE the upload ran (up to 60s) was reverted when the
 * upload resolved. This drives the real component: start an upload, re-render
 * with an edited app name, then let the upload finish.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DEFAULT_SETTINGS, type PWASettings } from './types';

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('../../../../../lib/api', () => ({ getApiUrl: () => 'http://api.test' }));

let dropFiles: ((files: FileList) => void) | null = null;
vi.mock('../../../../../components/image-upload/UploadDropzone', () => ({
  UploadDropzone: ({
    onFiles,
    children,
  }: {
    onFiles: (f: FileList) => void;
    children: ReactNode;
  }) => {
    dropFiles = onFiles;
    return <div>{children}</div>;
  },
}));
vi.mock('../../../../../components/image-upload/UploadProgress', () => ({
  UploadProgress: () => null,
}));

/** A controllable XHR: the test decides when the upload "finishes". */
class FakeXhr {
  static last: FakeXhr | null = null;
  upload = { addEventListener: vi.fn() };
  status = 0;
  responseText = '';
  timeout = 0;
  withCredentials = false;
  private listeners: Record<string, () => void> = {};
  constructor() {
    FakeXhr.last = this;
  }
  addEventListener(type: string, cb: () => void) {
    this.listeners[type] = cb;
  }
  open() {}
  setRequestHeader() {}
  send() {}
  finish(body: unknown) {
    this.status = 200;
    this.responseText = JSON.stringify(body);
    this.listeners.load?.();
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  dropFiles = null;
  FakeXhr.last = null;
});

describe('PwaIconUploader merges against the settings current at upload RESOLVE time', () => {
  it('keeps a sibling edit made while the upload was in flight', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { PwaIconUploader } = await import('./PwaIconUploader');
    const onChange = vi.fn();
    const before: PWASettings = { ...DEFAULT_SETTINGS, appName: 'Old name' };

    const { rerender } = render(
      <PwaIconUploader storeId="s1" settings={before} pwaEnabled onChange={onChange} />
    );

    const file = new File(['x'], 'icon.png', { type: 'image/png' });
    let uploadDone: Promise<void> | undefined;
    act(() => {
      uploadDone = dropFiles!([file] as unknown as FileList) as unknown as Promise<void>;
    });

    // The merchant types a new app name while the upload is still running.
    const edited: PWASettings = { ...before, appName: 'New name' };
    rerender(<PwaIconUploader storeId="s1" settings={edited} pwaEnabled onChange={onChange} />);

    await act(async () => {
      FakeXhr.last!.finish({
        success: true,
        data: { settings: { ...before, icon192: 'https://cdn/icon192-v2.png' } },
      });
      await uploadDone;
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const merged = onChange.mock.calls[0]![0] as PWASettings;
    expect(merged.icon192).toBe('https://cdn/icon192-v2.png');
    expect(merged.appName).toBe('New name');
  });
});
