/**
 * Regression for #1915: PwaIconUploader called onChange(updatedSettings)
 * with the FULL server-persisted settings object, wholesale-replacing the
 * page's local state and discarding any unsaved edits in sibling sections
 * (app name, theme color, iOS settings…) the merchant made but hadn't
 * clicked "Save" for yet.
 */
import { describe, it, expect } from 'vitest';
import { mergeIconFields } from './PwaIconUploader';
import { DEFAULT_SETTINGS, type PWASettings } from './types';

describe('mergeIconFields (#1915)', () => {
  it('takes the new icon URLs from the upload response', () => {
    const current: PWASettings = { ...DEFAULT_SETTINGS };
    const uploaded: PWASettings = {
      ...DEFAULT_SETTINGS,
      icon192: 'https://cdn/icon192-v2.png',
      icon512: 'https://cdn/icon512-v2.png',
      maskableIcon: 'https://cdn/maskable-v2.png',
    };

    const result = mergeIconFields(current, uploaded);

    expect(result.icon192).toBe('https://cdn/icon192-v2.png');
    expect(result.icon512).toBe('https://cdn/icon512-v2.png');
    expect(result.maskableIcon).toBe('https://cdn/maskable-v2.png');
  });

  it('preserves an UNSAVED edit in a sibling field — the defect this closes', () => {
    const current: PWASettings = {
      ...DEFAULT_SETTINGS,
      appName: 'My New Unsaved Name',
      themeColor: '#123456',
    };
    // The server's response reflects what was persisted BEFORE this local
    // edit — the stale appName/themeColor the merchant hasn't saved yet.
    const uploaded: PWASettings = {
      ...DEFAULT_SETTINGS,
      appName: 'Old Saved Name',
      themeColor: '#f97316',
      icon192: 'https://cdn/icon192-v2.png',
    };

    const result = mergeIconFields(current, uploaded);

    expect(result.appName).toBe('My New Unsaved Name');
    expect(result.themeColor).toBe('#123456');
    expect(result.icon192).toBe('https://cdn/icon192-v2.png');
  });
});
