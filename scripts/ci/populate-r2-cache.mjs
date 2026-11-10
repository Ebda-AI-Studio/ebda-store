// Ruling DEPLOY-R2-POPULATE-2: populate the OpenNext R2 incremental cache through the Cloudflare REST API
// (`wrangler r2 object put --remote`) instead of OpenNext's remote-proxy worker, whose tunnel never answers on
// the self-hosted Umbra runner. Assets and keys come from OpenNext's OWN code (getCacheAssets + computeCacheKey),
// so the objects are byte-for-byte what `opennextjs-cloudflare deploy` would have written.
//
// Run from apps/web after the OpenNext build:  node ../../scripts/ci/populate-r2-cache.mjs
// Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';

/** Pure: the upload plan [{ key, file }] for the given OpenNext cache assets. */
// Ruling WEB-COLD-2: build-time `fetch` entries are NOT uploaded. The storefront reads every fetch entry from ONE
// build-independent key space (apps/web/shared-fetch-cache.ts), so a copy fetched at build time would overwrite a newer
// entry the running Worker wrote, stamped with the upload time as if it were fresh. The runtime fills them on first read.
export function planUploads(assets, prefix, computeCacheKey) {
  const plan = assets
    .filter(a => !a.isFetch)
    .map(a => ({
      key: computeCacheKey(a.key, { prefix, buildId: a.buildId, cacheType: 'cache' }),
      file: a.fullPath,
    }));
  const seen = new Set();
  for (const p of plan) {
    if (seen.has(p.key)) throw new Error(`duplicate R2 cache key in the plan: ${p.key}`);
    seen.add(p.key);
  }
  return plan;
}

/**
 * Upload every plan entry through `put(bucket, key, file)` (returns { ok, error }), `concurrency` at a time,
 * retrying each entry up to `retries` times. Throws naming the key when one entry exhausts its retries.
 */
export async function uploadAll(
  plan,
  bucket,
  put,
  {
    concurrency = 2,
    retries = 4,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    log = console.log,
    sizeOf = () => 0,
  } = {}
) {
  let next = 0;
  let bytes = 0;
  let done = 0;
  async function worker() {
    while (next < plan.length) {
      const entry = plan[next++];
      let last = '';
      for (let attempt = 1; attempt <= retries; attempt++) {
        const r = await put(bucket, entry.key, entry.file);
        if (r.ok) {
          bytes += sizeOf(entry.file);
          done++;
          last = '';
          break;
        }
        last = r.error;
        log(`r2 put failed (attempt ${attempt}/${retries}) ${entry.key}: ${last}`);
        if (attempt < retries) await sleep(500 * 2 ** attempt);
      }
      if (last)
        throw new Error(
          `R2 cache upload failed for key ${entry.key} after ${retries} attempts: ${last}`
        );
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, plan.length)) }, worker)
  );
  log(`populated ${done}/${plan.length} R2 cache entries, ${bytes} bytes, bucket ${bucket}`);
  return { count: done, bytes };
}

function wranglerPut(bucket, key, file) {
  const r = spawnSync(
    'npx',
    ['wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--remote'],
    {
      encoding: 'utf8',
      timeout: 120_000,
      env: process.env,
    }
  );
  if (r.status === 0) return { ok: true };
  return {
    ok: false,
    error: (r.error?.message ?? r.stderr ?? '').toString().trim().slice(-400) || `exit ${r.status}`,
  };
}

async function main() {
  const require = createRequire(path.join(process.cwd(), 'noop.js'));
  // The package root entry is dist/api/index.js (package.json itself is not exported).
  const dist = path.dirname(path.dirname(require.resolve('@opennextjs/cloudflare')));
  // The CLI modules are not in the package's `exports` map; the version is pinned by the lockfile, so load by file URL.
  const load = rel => import(pathToFileURL(path.join(dist, rel)).href);
  const { getCacheAssets } = await load('cli/commands/populate-cache.js');
  const { retrieveCompiledConfig, getNormalizedOptions, readWranglerConfig } = await load(
    'cli/commands/utils/utils.js'
  );
  const { getEnvFromPlatformProxy } = await load('cli/commands/utils/helpers.js');
  const { computeCacheKey } = await load('api/overrides/internal.js');
  const r2 = await load('api/overrides/incremental-cache/r2-incremental-cache.js'); // NAME, BINDING_NAME, PREFIX_ENV_NAME

  const { config } = await retrieveCompiledConfig();
  const buildOpts = getNormalizedOptions(config);
  const wranglerConfig = await readWranglerConfig({});
  const envVars = await getEnvFromPlatformProxy({}, buildOpts);

  const incremental = config.default?.override?.incrementalCache;
  if (config.dangerous?.disableIncrementalCache || !incremental) {
    console.log('incremental cache disabled in the OpenNext config: nothing to populate');
    return;
  }
  const name = typeof incremental === 'function' ? (await incremental()).name : incremental;
  if (name !== r2.NAME) {
    throw new Error(
      `unexpected incremental cache override "${name}": this script only handles the R2 cache`
    );
  }
  const binding = wranglerConfig.r2_buckets.find(b => b.binding === r2.BINDING_NAME);
  if (!binding || typeof binding.bucket_name !== 'string')
    throw new Error(`no R2 binding ${r2.BINDING_NAME} with a bucket_name in the wrangler config`);
  if (binding.jurisdiction)
    throw new Error('R2 jurisdiction is set; this script does not pass --jurisdiction');

  const plan = planUploads(getCacheAssets(buildOpts), envVars[r2.PREFIX_ENV_NAME], computeCacheKey);
  if (plan.length === 0) return console.log('no cache assets to populate');
  await uploadAll(plan, binding.bucket_name, wranglerPut, { sizeOf: f => statSync(f).size });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
