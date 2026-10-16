// @vitest-environment jsdom
/**
 * Re-review nit (round 2): MultiImageUpload attached the uploaded URLs to the `values` it had
 * captured BEFORE the upload's await, so an edit made while an upload was in flight (remove,
 * reorder, or another image attached) was overwritten when the upload finished. The attach
 * must append to the CURRENT values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MultiImageUpload } from '../../apps/admin/src/components/ImageUpload';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: Record<string, unknown>) => <img alt="" {...props} />,
}));

/** One XHR that answers only when the test releases it. */
const pending: Array<() => void> = [];
class HeldXhr {
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
    pending.push(() => {
      this.status = 200;
      this.responseText = JSON.stringify({
        success: true,
        data: { files: names.map(n => ({ url: `https://cdn/${n}` })) },
      });
      this.listeners.load?.();
    });
  }
}

let latest: string[] = [];
function Harness() {
  const [values, setValues] = useState<string[]>(['https://cdn/old.png']);
  latest = values;
  return (
    <>
      <button type="button" onClick={() => setValues(v => [...v, 'https://cdn/edited.png'])}>
        edit-during-upload
      </button>
      <MultiImageUpload values={values} onChange={setValues} storeId="store-1" />
    </>
  );
}

afterEach(() => {
  cleanup();
  pending.length = 0;
  vi.unstubAllGlobals();
});

describe('MultiImageUpload attaches to the current values, not a stale copy', () => {
  it('an image added while the upload runs survives the attach', async () => {
    vi.stubGlobal('XMLHttpRequest', HeldXhr);
    const { container } = render(<Harness />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(pending).toHaveLength(1);

    fireEvent.click(screen.getByText('edit-during-upload'));
    expect(latest).toEqual(['https://cdn/old.png', 'https://cdn/edited.png']);

    await act(async () => {
      pending[0]();
      await new Promise(r => setTimeout(r, 0));
    });
    expect(latest).toEqual(['https://cdn/old.png', 'https://cdn/edited.png', 'https://cdn/a.png']);
  });
});
