/**
 * B0 Task 7: the `video` setting kind, the byte sniffer behind POST
 * /uploads/video, and the admin VideoField's client-side size/type guard.
 */
import { describe, it, expect } from 'vitest';
import { settingFactories as s } from '@ebda/shared';
import type { SettingType } from '@ebda/shared';
import { sniffVideo, VIDEO_MAX_BYTES } from '@api/lib/video-sniff';
import {
  checkVideoFile,
  formatMegabytes,
  VIDEO_MAX_BYTES as CLIENT_MAX,
} from '../../apps/admin/src/lib/video-upload';

const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'latin1'),
  Buffer.alloc(16),
]);
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x84]),
  Buffer.from('webm', 'latin1'),
  Buffer.alloc(16),
]);
const MKV = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88]),
  Buffer.from('matroska', 'latin1'),
  Buffer.alloc(16),
]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49]);

describe("setting kind 'video'", () => {
  it('s.video mirrors s.image: content group, extra merges', () => {
    const def = s.video('video', 'Video', 'الفيديو', { localized: true });
    expect(def).toEqual({
      id: 'video',
      type: 'video',
      labelEn: 'Video',
      labelAr: 'الفيديو',
      group: 'content',
      localized: true,
    });
    const img = s.image('image', 'Image', 'الصورة');
    expect(Object.keys(def).filter(k => k !== 'localized')).toEqual(Object.keys(img));
  });

  it("'video' is a SettingType", () => {
    const t: SettingType = 'video';
    expect(t).toBe('video');
  });
});

describe('sniffVideo', () => {
  it('detects mp4 by ftyp at offset 4', () => expect(sniffVideo(MP4)).toBe('video/mp4'));
  it('detects webm by EBML magic + webm doctype', () =>
    expect(sniffVideo(WEBM)).toBe('video/webm'));
  it('rejects matroska, png, empty and short buffers', () => {
    expect(sniffVideo(MKV)).toBeNull();
    expect(sniffVideo(PNG)).toBeNull();
    expect(sniffVideo(Buffer.alloc(0))).toBeNull();
    expect(sniffVideo(Buffer.from('ftyp'))).toBeNull();
  });
  it('accepts every allowlisted major brand and rejects heic/avif/quicktime/3gp', () => {
    const box = (brand: string) =>
      Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from(`ftyp${brand}`, 'latin1'),
        Buffer.alloc(16),
      ]);
    for (const b of [
      'isom',
      'iso2',
      'iso3',
      'iso4',
      'iso5',
      'iso6',
      'mp41',
      'mp42',
      'avc1',
      'dash',
      'M4V ',
    ]) {
      expect(sniffVideo(box(b))).toBe('video/mp4');
    }
    for (const b of ['heic', 'avif', 'qt  ', '3gp4', 'mif1']) expect(sniffVideo(box(b))).toBeNull();
  });
  it('does not treat "ftyp" at offset 0 as mp4', () => {
    expect(sniffVideo(Buffer.from('ftypmp42000000000000'))).toBeNull();
  });
});

describe('VideoField client-side guard', () => {
  it('uses the same 6 MB cap as the API', () => {
    expect(CLIENT_MAX).toBe(6 * 1024 * 1024);
    expect(CLIENT_MAX).toBe(VIDEO_MAX_BYTES);
  });
  it('accepts mp4/webm at exactly 6 MB, rejects one byte over', () => {
    expect(checkVideoFile({ size: CLIENT_MAX, type: 'video/mp4' })).toBe('ok');
    expect(checkVideoFile({ size: CLIENT_MAX, type: 'video/webm' })).toBe('ok');
    expect(checkVideoFile({ size: CLIENT_MAX + 1, type: 'video/mp4' })).toBe('too-large');
  });
  it('rejects other types', () => {
    expect(checkVideoFile({ size: 10, type: 'image/png' })).toBe('bad-type');
    expect(checkVideoFile({ size: 10, type: 'video/quicktime' })).toBe('bad-type');
    expect(checkVideoFile({ size: 10, type: '' })).toBe('bad-type');
  });
  it('formats megabytes with one decimal and never NaN', () => {
    expect(formatMegabytes(2.5 * 1024 * 1024)).toBe('2.5');
    expect(formatMegabytes(NaN)).toBe('0.0');
    expect(formatMegabytes(2.5 * 1024 * 1024, 'ar')).toBe('٢٫٥');
  });
});
