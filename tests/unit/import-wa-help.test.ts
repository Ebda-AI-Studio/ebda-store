import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build helper
import { convert, splitFrontMatter } from '../../apps/help/scripts/import-wa-help.mjs';
import { toHelpArticle } from '../../packages/shared/src/foundation/help-article';

const BODY =
  '# Verify your business\n\nFirst paragraph here.\n\n## Step\n\nSee [guide](02-x.md).\n';

describe('import-wa-help convert', () => {
  it('carries capabilities and appPath from the source front matter and keeps title, description, section, order', () => {
    const out = convert(`---\ncapabilities:\n  - a.b@1\nappPath: /x\n---\n\n${BODY}`, 'en', 7);
    const { fm, rest } = splitFrontMatter(out);
    expect(fm).toContain("title: 'Verify your business'");
    expect(fm).toContain("description: 'First paragraph here.'");
    expect(fm).toContain('order: 7');
    expect(fm).toContain('appPath: /x');
    expect(rest).toContain('(/en/whatsapp/x/)');
    const a = toHelpArticle('whatsapp/v', 'en', out);
    expect(a.capabilities).toEqual([{ id: 'a.b', version: 1 }]);
    expect(a.appPath).toBe('/x');
  });

  it('a source without front matter converts to the same shape as before (no capability keys)', () => {
    const out = convert(BODY, 'ar', 2);
    expect(out.startsWith("---\ntitle: 'Verify your business'\n")).toBe(true);
    expect(out).not.toContain('capabilities');
    expect(out).toContain('(/whatsapp/x/)'.replace('x', 'x'));
  });

  it('appends the Store registry ids that document a guide (STORE_LINKS) once', () => {
    const out = convert(BODY, 'en', 3, 'use-the-shared-number');
    const a = toHelpArticle('whatsapp/use-the-shared-number', 'en', out);
    expect(a.capabilities.map(c => c.id)).toEqual(['chat.ref-help']);
  });

  it('escapes braces outside code so a {{1}} template variable does not break MDX', () => {
    const out = convert('# T\n\nUse {{1}} and `{{2}}`.\n', 'en', 1);
    expect(out).toContain('Use \\{\\{1\\}\\} and `{{2}}`.');
  });
});
