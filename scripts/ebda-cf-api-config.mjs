// Produce a deploy-only config from reviewed bindings; never embed credentials.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AI_LINE = /^([ \t]*)("ai":[ \t]*\{[ \t]*"binding":[ \t]*"AI"[ \t]*\},?[ \t]*\r?\n)/gm;

/**
 * The Cloudflare Images binding (PWA icon resizing, Ruling D1016-ICONS-1) goes into the deploy
 * config only when the repo variable EBDA_IMAGES_BINDING is exactly "true": until Images is
 * confirmed on the Whisky account, a deploy must not depend on it. The code falls back to
 * storing the icon source unchanged when the binding is absent.
 */
export function withImagesBinding(source, flag) {
  if (flag !== 'true') return source;
  // Every "ai" line — the top level and each `env.*` section (review M3) — gets an images line
  // at the same indent, so no environment deploys without the binding.
  if (!source.match(AI_LINE))
    throw new Error('wrangler config has no "ai" binding line to anchor "images"');
  return source.replace(AI_LINE, '$1$2$1"images": { "binding": "IMAGES" },\n');
}

function main() {
  const bindings = ['EBDA_KV_CACHE_ID'];
  const ids = bindings.map(name => {
    const value = process.env[name] || '';
    if (!/^[a-f0-9]{32}$/i.test(value) || /^0+$/.test(value))
      throw new Error(`${name} must be a provisioned Cloudflare resource ID`);
    return value;
  });
  // D1 ids are UUIDs, not the 32-hex shape of the KV id. Each binding has its OWN distinct placeholder and is replaced as a whole token
  // (never a prefix/substring), so one id can never land on the other binding.
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const d1Bindings = [
    {
      name: 'EBDA_PLATFORM_D1_ID',
      placeholder: '00000000-0000-0000-0000-000000000000',
      label: 'D1 ebda-platform',
    },
    {
      name: 'EBDA_INSTAPAY_DEDUPE_D1_ID',
      placeholder: '00000000-0000-0000-0000-000000000001',
      label: 'D1 ebda-instapay-dedupe',
    },
  ];
  const d1Ids = d1Bindings.map(({ name, label }) => {
    const value = process.env[name] || '';
    if (!UUID.test(value) || /^[0-]+1?$/.test(value))
      throw new Error(`${name} must be the provisioned ${label} database id`);
    return value;
  });
  if (new Set(d1Ids.map(v => v.toLowerCase())).size !== d1Ids.length)
    throw new Error(
      'EBDA_PLATFORM_D1_ID and EBDA_INSTAPAY_DEDUPE_D1_ID must be different databases'
    );
  const source = readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8');
  let i = 0;
  let config = source.replace(/00000000000000000000000000000000/g, () => ids[i++]);
  d1Bindings.forEach(({ placeholder }, n) => {
    // Whole-token match: not preceded or followed by a hex digit or dash.
    config = config.replace(
      new RegExp(`(?<![0-9a-f-])${placeholder}(?![0-9a-f-])`, 'gi'),
      () => d1Ids[n]
    );
  });
  for (const { placeholder, label } of d1Bindings)
    if (config.includes(placeholder)) throw new Error(`${label} placeholder survived substitution`);
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
