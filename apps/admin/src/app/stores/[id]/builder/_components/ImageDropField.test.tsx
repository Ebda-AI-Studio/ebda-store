// @vitest-environment jsdom
/** F53: a large drop target with Replace / Remove, a dropped image is uploaded and replaces the value. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
const upload = vi.fn(async () => 'https://media.test/new.jpg');
vi.mock('../../../../../hooks/useImageUpload', () => ({
  useImageUpload: () => ({ uploadSingle: upload, uploading: false, error: null }),
}));
vi.mock('./MediaPicker', () => ({
  MediaPicker: ({ onPick }: { onPick: (u: string) => void }) => (
    <button onClick={() => onPick('https://media.test/picked.jpg')}>picker</button>
  ),
}));

import { ImageDropField } from './ImageDropField';

afterEach(cleanup);
const mount = (value = '') => {
  const onChange = vi.fn();
  render(<ImageDropField storeId="s1" label="Photo" tag="" value={value} onChange={onChange} />);
  return onChange;
};
const file = (type: string) => new File(['x'], 'a.' + type.split('/')[1], { type });
const drop = (f: File) =>
  fireEvent.drop(screen.getByTestId('image-drop'), { dataTransfer: { files: [f] } });

describe('ImageDropField', () => {
  it('empty: a large target (min 112px) with the drop prompt, no Remove', () => {
    mount();
    const t = screen.getByTestId('image-drop');
    expect(t.className).toContain('min-h-28');
    expect(t.textContent).toContain('dropImage');
    expect(screen.queryByRole('button', { name: /removeImage/ })).toBeNull();
  });
  it('filled: a large preview, Replace and Remove as buttons; Remove clears', () => {
    const onChange = mount('https://media.test/a.jpg');
    expect(screen.getByTestId('image-drop').querySelector('img')?.className).toContain('h-28');
    fireEvent.click(screen.getByRole('button', { name: /removeImage/ }));
    expect(onChange).toHaveBeenCalledWith(undefined);
    expect(screen.getByRole('button', { name: /changeImage/ })).toBeTruthy();
  });
  it('dropping an image uploads it and replaces the value', async () => {
    const onChange = mount('https://media.test/a.jpg');
    drop(file('image/png'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('https://media.test/new.jpg'));
    expect(upload).toHaveBeenCalledWith(expect.any(File), 'builder', 's1');
  });
  it('dropping a non-image changes nothing', () => {
    upload.mockClear();
    const onChange = mount();
    drop(file('application/pdf'));
    expect(upload).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
  it('Replace opens the media library and a pick replaces the value', () => {
    const onChange = mount('https://media.test/a.jpg');
    fireEvent.click(screen.getByRole('button', { name: /changeImage/ }));
    fireEvent.click(screen.getByText('picker'));
    expect(onChange).toHaveBeenCalledWith('https://media.test/picked.jpg');
  });
});
