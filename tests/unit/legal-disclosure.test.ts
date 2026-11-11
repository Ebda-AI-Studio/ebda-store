import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (f: string) =>
  readFileSync(resolve(__dirname, '../../apps/marketing/src/lib', f), 'utf8');

// F-14 + MKT-LEGAL-PROVIDERS-1: the privacy policy discloses the cookieless Cloudflare beacon
// and names its sub-processors in both languages.
describe('privacy policy disclosures', () => {
  it.each(['legal-en.ts', 'legal-ar.ts'])('%s discloses Cloudflare Web Analytics', f => {
    expect(read(f)).toContain('Cloudflare Web Analytics');
  });
  it.each(['Cloudflare', 'Sentry', 'Google Gemini', 'PostHog', 'OneSignal', 'Kashier'])(
    'names %s as a provider',
    name => {
      expect(read('legal-privacy-stack.ts')).toContain(name);
    }
  );
});
