import { readdirSync } from 'node:fs';
import path from 'node:path';

/** Chromium from PLAYWRIGHT_BROWSERS_PATH (default /opt/pw-browsers). Never installs a browser. */
export function chromiumPath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dir = readdirSync(base)
    .filter(d => /^chromium-\d+$/.test(d))
    .sort()
    .pop();
  return dir ? path.join(base, dir, 'chrome-linux', 'chrome') : undefined;
}
