// @vitest-environment jsdom
/**
 * B0-46: an upload the API refuses by its bytes (INVALID_IMAGE_CONTENT / INVALID_FONT_CONTENT)
 * answers in both languages (`details.messageEn` / `details.messageAr`). The upload readers
 * bypass `apiRequest`, so they localize through the same `localizedApiMessage` it uses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { uploadErrorText } from '../../apps/admin/src/hooks/useImageUpload';

const body = {
  success: false,
  error: {
    code: 'INVALID_IMAGE_CONTENT',
    message: 'The file is not a JPEG, PNG, GIF or WebP image',
    details: {
      messageEn: 'The file is not a JPEG, PNG, GIF or WebP image',
      messageAr: 'الملف ليس صورة JPEG أو PNG أو GIF أو WebP',
    },
  },
};

afterEach(() => {
  document.documentElement.dir = '';
});

describe('upload error text follows the admin language', () => {
  it('Arabic admin (rtl) shows the Arabic text', () => {
    document.documentElement.dir = 'rtl';
    expect(uploadErrorText(body, 'fallback')).toBe('الملف ليس صورة JPEG أو PNG أو GIF أو WebP');
  });
  it('English admin shows the English text', () => {
    document.documentElement.dir = 'ltr';
    expect(uploadErrorText(body, 'fallback')).toBe(body.error.message);
  });
  it('a body without a message falls back', () => {
    expect(uploadErrorText({ success: false }, 'fallback')).toBe('fallback');
    expect(uploadErrorText(undefined, 'fallback')).toBe('fallback');
  });
});
