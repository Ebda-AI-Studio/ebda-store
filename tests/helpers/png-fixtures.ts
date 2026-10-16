/**
 * A PNG that is real enough for the API's byte checks (magic + IHDR with the given size),
 * built without `sharp` so no test needs the native addon the Worker cannot load.
 */
export function fakePng(width: number, height: number, padTo = 64): Buffer {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // chunk length
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // colour type RGBA
  const body = Buffer.concat([magic, ihdr]);
  return body.length >= padTo ? body : Buffer.concat([body, Buffer.alloc(padTo - body.length)]);
}

export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0, 0, 0, 0, 0, 0]);
export const GIF_BYTES = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1');
