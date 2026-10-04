/**
 * Generates the OpenAPI document at BUILD time from the API's own swagger-jsdoc annotations
 * (apps/api/src/docs/swagger.ts + the `@swagger` blocks in apps/api/src/routes/*.ts).
 * Output: apps/docs/.generated/openapi.json. The docs site never calls the API at runtime.
 *
 * swagger-jsdoc resolves `./src/routes/*.ts` against the cwd, so we chdir into apps/api first.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '../../api');
process.chdir(apiDir);

// Importing the API's swagger module pulls in its config loader, which warns when no
// DATABASE_URL etc. is set. Those warnings are irrelevant here and nothing connects.
const { swaggerSpec } = (await import(
  pathToFileURL(path.join(apiDir, 'src/docs/swagger.ts')).href
)) as { swaggerSpec: { paths?: Record<string, unknown> } };

const outDir = path.resolve(here, '../.generated');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'openapi.json'), JSON.stringify(swaggerSpec, null, 2));
// Honest coverage figure for the docs: how many route handlers exist vs carry an annotation.
const routesDir = path.join(apiDir, 'src/routes');
let handlers = 0;
for (const f of readdirSync(routesDir).filter(n => n.endsWith('.routes.ts'))) {
  handlers += (
    readFileSync(path.join(routesDir, f), 'utf8').match(
      /^router\.(get|post|put|patch|delete)\(/gm
    ) ?? []
  ).length;
}
let operations = 0;
for (const item of Object.values(swaggerSpec.paths ?? {}))
  operations += Object.keys(item as object).length;
writeFileSync(
  path.join(outDir, 'coverage.json'),
  JSON.stringify({
    handlers,
    operations,
    generatedFrom: 'apps/api/src/routes/*.ts @swagger blocks',
  })
);
console.log(
  `openapi.json written: ${Object.keys(swaggerSpec.paths ?? {}).length} documented paths`
);
