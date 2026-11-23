import { describe, expect, it, vi } from 'vitest';
import type { PageDefinition } from '@ebda/shared';
import { applyAiPatchToDraft } from './apply-ai-patch';

const doc = { sections: [] } as unknown as PageDefinition;
const base = () => ({
  candidate: doc,
  replaceDocument: vi.fn(),
  undo: vi.fn(),
  addToast: vi.fn(),
  appliedLabel: 'applied',
  undoLabel: 'undo',
});

describe('applyAiPatchToDraft', () => {
  it('replaces the document, saves, and the success toast carries an Undo that undoes', async () => {
    const a = { ...base(), saveDraftNow: vi.fn().mockResolvedValue(true) };
    expect(await applyAiPatchToDraft(a)).toBe(true);
    expect(a.replaceDocument).toHaveBeenCalledWith(doc);
    const toast = a.addToast.mock.calls[0]![0];
    expect(toast.title).toBe('applied');
    expect(toast.action.label).toBe('undo');
    toast.action.onClick();
    expect(a.undo).toHaveBeenCalledTimes(1);
  });

  it('shows no success toast when the draft could not be saved', async () => {
    const a = { ...base(), saveDraftNow: vi.fn().mockResolvedValue(false) };
    expect(await applyAiPatchToDraft(a)).toBe(false);
    expect(a.addToast).not.toHaveBeenCalled();
  });
});
