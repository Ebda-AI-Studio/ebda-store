import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Prod P1 (catalog-import-uploads-sweep: "DOMParser is not defined"): wrangler resolves @aws-sdk/xml-builder to its `browser`
// parser, which needs the global DOMParser that Workers lack. wrangler.jsonc aliases the package to a stub re-exporting the
// SDK's DOM-free parser by file path. The behaviour is proven on workerd by apps/api/workers-test/s3-xml.test.ts; this pins the
// wiring (alias present, stub and the three SDK files it points at exist) where the workers pool does not run.
const API = join(__dirname, '../../../apps/api');

describe('@aws-sdk/xml-builder alias for the Workers bundle', () => {
  const wrangler = readFileSync(join(API, 'wrangler.jsonc'), 'utf8');
  const stub = readFileSync(join(API, 'src/cf/stubs/aws-xml-builder.ts'), 'utf8');

  it('wrangler.jsonc aliases the package to the stub, which exists', () => {
    expect(wrangler).toMatch(
      /"@aws-sdk\/xml-builder":\s*"\.\/src\/cf\/stubs\/aws-xml-builder\.ts"/
    );
    expect(existsSync(join(API, 'src/cf/stubs/aws-xml-builder.ts'))).toBe(true);
  });

  it('every SDK file the stub re-exports resolves from apps/api and none is the DOMParser parser', () => {
    const resolveFromApi = createRequire(join(API, 'package.json')).resolve;
    const targets = [...stub.matchAll(/from '([^']+)'/g)].map(m => m[1]!);
    expect(targets.length).toBe(3);
    for (const t of targets) {
      expect(t).toMatch(/^@aws-sdk\/xml-builder\/dist-es\//);
      expect(t).not.toMatch(/browser/);
      expect(existsSync(resolveFromApi(t)), t).toBe(true);
    }
    const parser = targets.find(t => t.includes('xml-parser'))!;
    expect(readFileSync(resolveFromApi(parser), 'utf8')).not.toContain('DOMParser');
  });
});
