// Small filesystem helpers for the static generators.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './mdx.mjs';

/** Read every `*.mdx` in `dir` (non-recursive) -> [{ file, slug, data, body }], by `order`. */
export function loadContent(dir) {
  return readdirSync(dir)
    .filter(f => f.endsWith('.mdx'))
    .map(file => {
      const { data, body } = parseFrontmatter(readFileSync(path.join(dir, file), 'utf8'));
      for (const k of ['title', 'description']) {
        if (!data[k]) throw new Error(`${path.join(dir, file)}: frontmatter "${k}" is required`);
      }
      return { file, slug: file.replace(/\.mdx$/, ''), data, body };
    })
    .sort((a, b) => (a.data.order ?? 999) - (b.data.order ?? 999) || a.slug.localeCompare(b.slug));
}

/** Empty `outDir`, then copy `publicDir` into it. */
export function resetOut(outDir, publicDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  if (publicDir && existsSync(publicDir)) cpSync(publicDir, outDir, { recursive: true });
}

/** Write `html` to `<outDir>/<urlPath>/index.html` (urlPath '/' -> index.html). */
export function writePage(outDir, urlPath, html) {
  const dir = path.join(outDir, urlPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), html);
}
