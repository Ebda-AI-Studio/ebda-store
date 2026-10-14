import QRCode from 'qrcode';
import { LOCALES } from './site';
import { MODEL3D_IDS, arPageUrl, qrPath } from './model3d';

/** Every QR image the 3D section can show: path under public/ and the URL it encodes. */
export function qrTargets() {
  return LOCALES.flatMap(locale =>
    MODEL3D_IDS.map(id => ({ path: qrPath(locale, id), url: arPageUrl(locale, id) }))
  );
}

/** One QR code as an SVG string: dark modules on white with a 2-module quiet zone, error level M. */
export function renderQr(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#121314', light: '#ffffff' },
  });
}
