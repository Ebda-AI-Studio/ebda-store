// Writes the desktop "see it in your room" QR codes (public/3d/qr/<vertical>-<locale>.svg) at
// build time, offline: no runtime third-party service. Each code opens that locale's page on the
// vertical it belongs to; the phone then taps the viewer's own AR button.
//   npm run qr -w apps/marketing        (re-run when the site URL or a vertical changes)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { qrTargets, renderQr } from '../../src/lib/model3d-qr';

async function main() {
  const out = path.resolve(__dirname, '..', '..', 'public');
  for (const t of qrTargets()) {
    const file = path.join(out, t.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, await renderQr(t.url));
    console.log('qr', t.path, '->', t.url);
  }
}

void main();
