/**
 * Task 13: a move is announced in a live region, in Egyptian Arabic ("اتنقل القسم لفوق") and in
 * English, whichever way it happened (drag, button, Alt+Arrow, canvas toolbar).
 */
import { describe, expect, it } from 'vitest';
import { layoutToDefinition, resolveLayoutSettings, reduceDocument } from '@ebda/shared';
import { describeMove } from './announce-move';

const doc = () => layoutToDefinition(resolveLayoutSettings({}, 'modern'));

describe('describeMove', () => {
  it('names the section that moved up, with its new position', () => {
    const prev = doc();
    const id = prev.sections[2].id;
    const next = reduceDocument(prev, { type: 'moveSection', id, toIndex: 1 }).doc;
    const m = describeMove(prev, next, id)!;
    expect(m).toMatchObject({ id, direction: 'up', pos: 2, total: prev.sections.length });
  });

  it('down', () => {
    const prev = doc();
    const id = prev.sections[0].id;
    const next = reduceDocument(prev, { type: 'moveSection', id, toIndex: 2 }).doc;
    expect(describeMove(prev, next, id)).toMatchObject({ id, direction: 'down', pos: 3 });
  });

  it('is null for an edit that is not a move, or a different set of sections', () => {
    const prev = doc();
    expect(describeMove(prev, prev)).toBeNull();
    const removed = reduceDocument(prev, { type: 'removeSection', id: prev.sections[3].id }).doc;
    expect(describeMove(prev, removed)).toBeNull();
  });
});
