// Produce a deploy-only config from reviewed bindings; never embed credentials.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const IMAGES_LINE = '  "images": { "binding": "IMAGES" },\n';
const AI_LINE = /^([ \t]*"ai":[ \t]*\{[ \t]*"binding":[ \t]*"AI"[ \t]*\},?[ \t]*\r?\n)/m;

/**
 * The Cloudflare Images binding (PWA icon resizing, Ruling D1016-ICONS-1) goes into the deploy
 * config only when the repo variable EBDA_IMAGES_BINDING is exactly "true": until Images is
 * confirmed on the Whisky account, a deploy must not depend on it. The code falls back to
 * storing the icon source unchanged when the binding is absent.
 */
export function withImagesBinding(source, flag) {
  if (flag !== 'true') return source;
  if (!AI_LINE.test(source))
    throw new Error('wrangler config has no "ai" binding line to anchor "images"');
  return source.replace(AI_LINE, `$1${IMAGES_LINE}`);
}

function main() {
  const bindings = ['EBDA_HYPERDRIVE_ID', 'EBDA_KV_CACHE_ID'];
  const ids = bindings.map(name => {
    const value = process.env[name] || '';
    if (!/^[a-f0-9]{32}$/i.test(value) || /^0+$/.test(value))
      throw new Error(`${name} must be a provisioned Cloudflare resource ID`);
    return value;
  });
  const source = readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8');
  let i = 0;
  const config = source.replace(/00000000000000000000000000000000/g, () => ids[i++]);
  if (i !== ids.length)
    throw new Error('Unexpected binding placeholders; review API config before deploying');
  writeFileSync(
    new URL('../apps/api/.wrangler.deploy.jsonc', import.meta.url),
    withImagesBinding(config, process.env.EBDA_IMAGES_BINDING)
  );
}

// Run as a script (realpath both sides: /var vs /private/var on macOS temp dirs).
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  main();
