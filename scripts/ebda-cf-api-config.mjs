// Produce a deploy-only config from reviewed bindings; never embed credentials.
import { readFileSync, writeFileSync } from 'node:fs';
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
writeFileSync(new URL('../apps/api/.wrangler.deploy.jsonc', import.meta.url), config);
