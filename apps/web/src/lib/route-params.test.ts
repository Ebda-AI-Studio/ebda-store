import { describe, it, expect } from 'vitest';
import { decodeRouteParam } from './route-params';

describe('decodeRouteParam', () => {
  it('decodes a raw percent-encoded Arabic slug (the page-component form)', () => {
    expect(decodeRouteParam('%D8%AE%D8%A8%D9%8A%D8%B5%D9%87')).toBe('خبيصه');
    expect(decodeRouteParam('%D8%A8%D9%8A%D9%83%D8%A7%D9%86-%D9%85%D8%B4%D9%83%D9%84')).toBe(
      'بيكان-مشكل'
    );
  });

  it('leaves an already-decoded slug untouched (the generateMetadata form)', () => {
    expect(decodeRouteParam('خبيصه')).toBe('خبيصه');
    expect(decodeRouteParam('بيكان-مشكل')).toBe('بيكان-مشكل');
  });

  it('is idempotent — double application never double-decodes', () => {
    const raw = '%D8%AE%D8%A8%D9%8A%D8%B5%D9%87';
    expect(decodeRouteParam(decodeRouteParam(raw))).toBe('خبيصه');
  });

  it('leaves plain ASCII slugs untouched', () => {
    expect(decodeRouteParam('almond-plain')).toBe('almond-plain');
    expect(decodeRouteParam('')).toBe('');
  });

  it('returns the raw value for a malformed escape instead of throwing', () => {
    expect(decodeRouteParam('50%-off')).toBe('50%-off');
    expect(decodeRouteParam('%')).toBe('%');
    expect(decodeRouteParam('%zz')).toBe('%zz');
  });

  it('decodes the `slug:` tenant key the middleware percent-encodes', () => {
    expect(decodeRouteParam('slug%3Apecannbee')).toBe('slug:pecannbee');
    expect(decodeRouteParam('slug:pecannbee')).toBe('slug:pecannbee');
  });
});
