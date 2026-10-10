// @vitest-environment jsdom
/**
 * Bug: "On a slow network, a false 'conflict' state locks the Publish
 * button." Root cause — the autosave debounce fired a NEW `saveNow` every
 * time `doc` changed even while the PREVIOUS `PUT …/draft` was still in
 * flight. Both concurrent requests read the same stale `revRef.current` as
 * their `baseRev` (the first hadn't resolved yet to bump it), so the second
 * always lost to the first with a 409 REV_CONFLICT — a false "another editor
 * changed this page", entirely self-inflicted, that permanently disabled
 * Publish (`saveState === 'conflict'`) until the merchant manually resolved
 * it.
 *
 * `useBuilderDocument` now queues every save (`enqueueSave`) on a single
 * `pendingSave` chain instead of firing them concurrently, so a save that
 * fires while one is already in flight waits for it and reads a FRESH rev —
 * never racing itself into a conflict.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PageDefinition } from '@force/shared';

type Pending = { url: string; body: unknown; resolve: (v: unknown) => void };
const puts: Pending[] = [];
const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPut = vi.fn();
vi.mock('../../../../../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiPut: (...a: unknown[]) => apiPut(...a),
}));

import { useBuilderDocument, AUTOSAVE_MS } from './useBuilderDocument';

const baseDoc: PageDefinition = {
  schemaVersion: 1,
  pageKey: 'home',
  sectionGroups: { header: [], footer: [] },
  sections: [{ id: 'hero', type: 'hero', settings: {} }],
  siteSettings: {},
};

const withSections = (n: number): PageDefinition => ({
  ...baseDoc,
  sections: [{ ...baseDoc.sections[0], settings: { count: n } }],
});

beforeEach(() => {
  puts.length = 0;
  apiGet.mockResolvedValue({
    data: { rev: 1, definition: withSections(0), source: 'draft', draftRev: 1, publishedRev: null },
    error: null,
  });
  apiPut.mockImplementation(
    (url: string, body: unknown) => new Promise(resolve => puts.push({ url, body, resolve }))
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('useBuilderDocument — autosave single-flight queue (slow-network false conflict)', () => {
  it('never sends two concurrent draft PUTs with the same baseRev, and never ends in a false conflict', async () => {
    const { result } = renderHook(() => useBuilderDocument('store-1'));
    await waitFor(() => expect(result.current.saveState).toBe('saved'));

    // First edit — arms the debounce. `replaceDocument` pushes a new doc
    // straight into history (no registry validation needed for this test —
    // we only care about the SAVE QUEUE behavior, not the reducer).
    act(() => result.current.replaceDocument(withSections(1)));
    await act(async () => wait(AUTOSAVE_MS + 50));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toMatchObject({ baseRev: 1 });

    // SLOW NETWORK: the first PUT is still unresolved. A second edit lands
    // and its own debounce elapses before the first request answers.
    act(() => result.current.replaceDocument(withSections(2)));
    await act(async () => wait(AUTOSAVE_MS + 50));
    // The buggy version fired a second concurrent PUT here, also baseRev: 1.
    expect(puts).toHaveLength(1);

    // First request finally resolves, bumping rev to 2.
    await act(async () => {
      puts[0].resolve({ data: { rev: 2, warnings: [] }, error: null });
    });

    // The queued second edit now fires, reading the FRESH rev (2), not the
    // stale one (1) that would 409 against what the first request just wrote.
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].body).toMatchObject({ baseRev: 2 });

    await act(async () => {
      puts[1].resolve({ data: { rev: 3, warnings: [] }, error: null });
    });

    await waitFor(() => expect(result.current.saveState).toBe('saved'));
    expect(result.current.conflict).toBeNull();
  });
});
