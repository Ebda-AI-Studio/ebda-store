import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P14: the tracking client must stay a dynamic chunk (outside the up-front JS budget and off the LCP path).
const src = (f: string) => readFileSync(join(__dirname, '../../apps/marketing/src', f), 'utf8');

describe('marketing tracker stays lazy', () => {
  it.each(['components/EbdaTracking.tsx', 'components/CookieSettingsButton.tsx'])(
    '%s imports the tracker dynamically only',
    f => {
      const s = src(f);
      expect(s).not.toMatch(/import\s+[^;]*from\s+'@\/lib\/tracker'/);
      expect(s).toContain("import('@/lib/tracker')");
    }
  );
  it('the root shell loads no Google Fonts', () => {
    expect(src('components/RootShell.tsx')).not.toContain('googleFontsUrl');
  });
});
