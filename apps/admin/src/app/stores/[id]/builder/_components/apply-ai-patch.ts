import type { PageDefinition } from '@ebda/shared';

/**
 * Apply an accepted AI proposal to the draft as ONE undo step, save it, and offer Undo in the toast.
 * Returns whether the draft was saved. Undo goes through the editor's own history (the save follows the
 * document change), so it is exactly what Ctrl+Z does.
 */
export async function applyAiPatchToDraft(a: {
  candidate: PageDefinition;
  replaceDocument: (doc: PageDefinition) => void;
  saveDraftNow: () => Promise<boolean>;
  undo: () => void;
  addToast: (toast: {
    type: 'success';
    title: string;
    action: { label: string; onClick: () => void };
  }) => void;
  appliedLabel: string;
  undoLabel: string;
}): Promise<boolean> {
  a.replaceDocument(a.candidate);
  const saved = await a.saveDraftNow();
  if (saved) {
    a.addToast({
      type: 'success',
      title: a.appliedLabel,
      action: { label: a.undoLabel, onClick: a.undo },
    });
  }
  return saved;
}
