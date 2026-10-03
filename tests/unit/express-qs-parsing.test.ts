/**
 * Issue 1194: the root `overrides.qs` forced qs 6.16.0 under express 4.22.2 /
 * body-parser, whose declared range was `~6.15.1` — a parser swap on the
 * production request path (every `req.query`, and `express.urlencoded({
 * extended: true })` in apps/api/src/index.ts) adopted a minor ahead of what
 * express pins, verified by nothing but a green install.
 *
 * express 4.22.3 widened its own range to `~6.16.0`, so the API now depends on
 * a version whose DECLARED range contains the qs it runs. This pins that, and
 * exercises the parsing shapes the storefront actually sends.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import semver from 'semver';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireFromApi = createRequire(path.resolve(__dirname, '../../apps/api/package.json'));
const pkg = (name: string, from = requireFromApi) =>
  JSON.parse(readFileSync(from.resolve(`${name}/package.json`), 'utf8')) as {
    version: string;
    dependencies?: Record<string, string>;
  };

describe('the qs the API runs is inside express/body-parser declared ranges (issue 1194)', () => {
  const expressPkg = pkg('express');
  const requireFromExpress = createRequire(requireFromApi.resolve('express/package.json'));
  const qsVersion = pkg('qs', requireFromExpress).version;

  it('express declares a qs range that contains the installed qs', () => {
    const range = expressPkg.dependencies?.qs;
    expect(range, 'express no longer declares qs').toBeTruthy();
    expect(
      semver.satisfies(qsVersion, range!),
      `qs ${qsVersion} is outside express ${expressPkg.version}'s declared ${range}`
    ).toBe(true);
  });

  it('body-parser (the urlencoded parser) declares a qs range that contains it too', () => {
    const bodyParser = pkg('body-parser', requireFromExpress);
    const range = bodyParser.dependencies?.qs;
    expect(range).toBeTruthy();
    expect(semver.satisfies(qsVersion, range!)).toBe(true);
  });
});

describe('query + extended-urlencoded parsing shapes the storefront sends', () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.get('/q', (req, res) => res.json(req.query));
  app.post('/b', (req, res) => res.json(req.body));

  it('bracket arrays (PLP facet filters) parse to arrays', async () => {
    const r = await request(app).get('/q?color[]=red&color[]=blue&size=M');
    expect(r.body).toEqual({ color: ['red', 'blue'], size: 'M' });
  });

  it('a comma-separated value stays one string (comma parsing is off by default)', async () => {
    const r = await request(app).get('/q?ids=a,b,c');
    expect(r.body).toEqual({ ids: 'a,b,c' });
  });

  it('nested objects parse under extended urlencoded', async () => {
    const r = await request(app)
      .post('/b')
      .type('form')
      .send('address[city]=Egypt&address[block]=3&tags[]=x&tags[]=y');
    expect(r.body).toEqual({ address: { city: 'Egypt', block: '3' }, tags: ['x', 'y'] });
  });

  it("an index past express's arrayLimit (1000) becomes an object key, not a sparse array", async () => {
    // express's query parser calls qs with arrayLimit: 1000 — the parsing
    // area GHSA-x5fp-wj9c-mxmx touched in 6.16.0. Inside the limit, a sparse
    // index compacts into a dense array; past it, the value is an object.
    const inside = await request(app).get('/q?a[100]=x');
    expect(inside.body.a).toEqual(['x']);
    const past = await request(app).get('/q?a[1001]=x');
    expect(Array.isArray(past.body.a)).toBe(false);
    expect(past.body.a).toEqual({ 1001: 'x' });
  });
});
