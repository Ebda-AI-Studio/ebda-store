// @vitest-environment jsdom
/**
 * Theme reset vs autosave: removing a key from the draft theme while a debounced save that still
 * carries the key is in flight must end with a PUT WITHOUT the key (the queue saves the latest
 * document after the in-flight one), so the key cannot be re-introduced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PageDefinition } from '@force/shared';

type Pending = { body: { definition: PageDefinition }; resolve: (v: unknown) => void };
const puts: Pending[] = [];
const apiGet = vi.fn();
const apiPut = vi.fn();
vi.mock('../../../../../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: vi.fn(),
  apiPut: (...a: unknown[]) => apiPut(...a),
}));

import { useBuilderDocument, AUTOSAVE_MS } from './useBuilderDocument';

const baseDoc = {
  schemaVersion: 1,
  pageKey: 'home',
  sectionGroups: { header: [], footer: [] },
  sections: [],
  siteSettings: {},
} as unknown as PageDefinition;
const withTheme = (theme: Record<string, string>) =>
  ({ ...baseDoc, theme }) as unknown as PageDefinition;

beforeEach(() => {
  puts.length = 0;
  apiGet.mockResolvedValue({
    data: { rev: 1, definition: baseDoc, source: 'draft', draftRev: 1, publishedRev: null },
    error: null,
  });
  apiPut.mockImplementation(
    (_u: string, body: Pending['body']) => new Promise(resolve => puts.push({ body, resolve }))
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('theme reset racing an in-flight autosave', () => {
  it('the last PUT omits the removed key', async () => {
    const { result } = renderHook(() => useBuilderDocument('store-1'));
    await waitFor(() => expect(result.current.saveState).toBe('saved'));

    act(() => result.current.replaceDocument(withTheme({ primaryColor: 'a', fontBody: 'b' })));
    await act(async () => wait(AUTOSAVE_MS + 50));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect((puts[0]!.body.definition as { theme?: object }).theme).toHaveProperty('primaryColor');

    // reset while that save is still in flight
    let done!: Promise<boolean>;
    act(() => {
      result.current.patchDocument(d => {
        const rest = { ...(d as { theme: Record<string, string> }).theme };
        delete rest.primaryColor;
        return { ...d, theme: rest } as unknown as PageDefinition;
      });
      done = result.current.saveDraftNow();
    });
    await act(async () => {
      puts[0]!.resolve({ data: { rev: 2, warnings: [] }, error: null });
    });
    await waitFor(() => expect(puts).toHaveLength(2));
    await act(async () => {
      puts[1]!.resolve({ data: { rev: 3, warnings: [] }, error: null });
    });
    expect(await done).toBe(true);
    expect((puts[1]!.body.definition as { theme: object }).theme).toEqual({ fontBody: 'b' });
  });
});
