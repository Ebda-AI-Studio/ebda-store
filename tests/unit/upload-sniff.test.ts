import { describe, it, expect } from 'vitest';
import { sniffImage, sniffFont, IMAGE_EXT } from '@api/lib/upload-sniff';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);

describe('sniffImage', () => {
  it('names the four accepted formats by their bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(IMAGE_EXT['image/jpeg']).toBe('.jpg');
  });
  it('refuses HTML, SVG, ICO and short buffers whatever they are called', () => {
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0]))).toBeNull();
    expect(sniffImage(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe('sniffFont', () => {
  it('names woff2/woff/otf/ttf and refuses anything else', () => {
    expect(sniffFont(Buffer.from('wOF2abcd'))).toBe('font/woff2');
    expect(sniffFont(Buffer.from('wOFFabcd'))).toBe('font/woff');
    expect(sniffFont(Buffer.from('OTTOabcd'))).toBe('font/otf');
    expect(sniffFont(Buffer.from([0, 1, 0, 0, 0, 0x0c]))).toBe('font/ttf');
    expect(sniffFont(Buffer.from('trueabcd'))).toBe('font/ttf');
    expect(sniffFont(Buffer.from('<html>'))).toBeNull();
  });
});
