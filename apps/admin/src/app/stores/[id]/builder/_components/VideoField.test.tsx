// @vitest-environment jsdom
/**
 * VideoField: a file over 6 MB is refused in the browser (Arabic message) and
 * never uploaded; a valid file uploads and previews muted + looping; Remove
 * clears the value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const uploadVideo = vi.hoisted(() => vi.fn(async () => 'https://media.test/x.mp4'));

vi.mock('next-intl', async () => {
  const ar = (await import('@/i18n/messages/ar.json')).default.builder
    .settings as unknown as Record<string, string>;
  const t = Object.assign(
    (key: string, vars?: Record<string, string>) =>
      (ar[key] ?? key).replace('{size}', vars?.size ?? ''),
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'ar' };
});
vi.mock('@/hooks/useImageUpload', () => ({
  useImageUpload: () => ({ uploadVideo, uploading: false, error: null }),
}));

import { VideoField } from './VideoField';

const file = (size: number, type: string) => {
  const f = new File(['x'], 'clip.mp4', { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

afterEach(() => {
  cleanup();
  uploadVideo.mockClear();
});

describe('VideoField', () => {
  it('refuses a file over 6 MB with the Arabic message and does not upload', async () => {
    const onChange = vi.fn();
    render(<VideoField storeId="s1" tag="" value="" onChange={onChange} />);
    fireEvent.change(screen.getByTestId('video-file-input'), {
      target: { files: [file(6 * 1024 * 1024 + 1, 'video/mp4')] },
    });
    expect((await screen.findByRole('alert')).textContent).toBe('الفيديو أكبر من ٦ ميجا');
    expect(uploadVideo).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uploads a valid file, then previews it muted and looping with a size readout', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<VideoField storeId="s1" tag="" value="" onChange={onChange} />);
    fireEvent.change(screen.getByTestId('video-file-input'), {
      target: { files: [file(2 * 1024 * 1024, 'video/mp4')] },
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('https://media.test/x.mp4'));
    expect(uploadVideo).toHaveBeenCalledWith(expect.any(File), 'builder', 's1');
    rerender(
      <VideoField storeId="s1" tag="" value="https://media.test/x.mp4" onChange={onChange} />
    );
    const v = screen.getByTestId('video-preview') as HTMLVideoElement;
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(screen.getByTestId('video-size').textContent).toBe('2.0 ميجا');
  });

  it('remove clears the value', () => {
    const onChange = vi.fn();
    render(<VideoField storeId="s1" tag="" value="https://media.test/x.mp4" onChange={onChange} />);
    fireEvent.click(screen.getByText('إزالة'));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
