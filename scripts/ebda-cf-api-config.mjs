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

const DEDUPE_PLACEHOLDER = '11111111-1111-1111-1111-111111111111';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DEDUPE_BLOCK =
  /\n[ \t]*\/\/ Ruling INSTAPAY-AUTO-1a[^\n]*\n(?:[ \t]*\/\/[^\n]*\n)*[ \t]*\{[^{}]*"binding":[ \t]*"INSTAPAY_DEDUPE_DB"[^{}]*\},?/;

/**
 * INSTAPAY-AUTO-1a: the shared InstaPay dedupe D1. With EBDA_INSTAPAY_DEDUPE_D1_ID set (a UUID that is NOT the platform D1) its id is
 * substituted; unset, the binding is DROPPED from the deploy config so a deploy never points at a placeholder (the code fails closed without
 * it: /health says not ready and every receipt waits for a person). The same id as the platform D1 is refused (a wrong shared table).
 */
export function withDedupeBinding(source, dedupeId, platformId) {
  if (!dedupeId) {
    const out = source.replace(DEDUPE_BLOCK, '');
    if (out.includes(DEDUPE_PLACEHOLDER))
      throw new Error('INSTAPAY_DEDUPE_DB placeholder survived the drop');
    return out;
  }
  if (!UUID.test(dedupeId) || dedupeId === DEDUPE_PLACEHOLDER)
    throw new Error(
      'EBDA_INSTAPAY_DEDUPE_D1_ID must be the provisioned D1 ebda-instapay-dedupe database id'
    );
  if (dedupeId === platformId)
    throw new Error('EBDA_INSTAPAY_DEDUPE_D1_ID must not be the platform D1');
  if (!source.includes(DEDUPE_PLACEHOLDER))
    throw new Error('wrangler config has no INSTAPAY_DEDUPE_DB placeholder');
  return source.replace(DEDUPE_PLACEHOLDER, dedupeId);
}

function main() {
  const bindings = ['EBDA_KV_CACHE_ID'];
  const ids = bindings.map(name => {
    const value = process.env[name] || '';
    if (!/^[a-f0-9]{32}$/i.test(value) || /^0+$/.test(value))
      throw new Error(`${name} must be a provisioned Cloudflare resource ID`);
    return value;
  });
  // D1 `ebda-platform` (task 2.4): a UUID, not the 32-hex shape of the one above.
  const d1Id = process.env.EBDA_PLATFORM_D1_ID || '';
  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(d1Id) ||
    d1Id === ZERO_UUID
  )
    throw new Error('EBDA_PLATFORM_D1_ID must be the provisioned D1 ebda-platform database id');
  const source = withDedupeBinding(
    readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8'),
    process.env.EBDA_INSTAPAY_DEDUPE_D1_ID || '',
    d1Id
  );
  let i = 0;
  const config = source
    .replace(/00000000000000000000000000000000/g, () => ids[i++])
    .replace(new RegExp(ZERO_UUID, 'g'), d1Id);
  if (config.includes(ZERO_UUID)) throw new Error('D1 placeholder survived substitution');
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
