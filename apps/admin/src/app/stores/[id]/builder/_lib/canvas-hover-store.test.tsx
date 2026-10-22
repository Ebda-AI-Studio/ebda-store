// @vitest-environment jsdom
/**
 * Task 13: canvas-only transient state (the hovered section) lives outside React state of the
 * editor, so a hover never re-renders the admin tree beyond the rows whose highlight flips.
 */
import { afterEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { cleanup, render } from '@testing-library/react';
import { setCanvasHover, useIsCanvasHovered } from './canvas-hover-store';

afterEach(() => {
  cleanup();
  setCanvasHover(null);
});

describe('canvas hover store', () => {
  it('only the row whose hovered state flips re-renders; the parent never does', () => {
    const renders = { parent: 0, a: 0, b: 0 };
    function Row({ id, k }: { id: string; k: 'a' | 'b' }) {
      renders[k]++;
      const hot = useIsCanvasHovered(id);
      return <li data-hot={hot ? '1' : '0'} data-testid={id} />;
    }
    const Row2 = React.memo(Row);
    function Parent() {
      renders.parent++;
      return (
        <ul>
          <Row2 id="a" k="a" />
          <Row2 id="b" k="b" />
        </ul>
      );
    }
    const { getByTestId } = render(<Parent />);
    expect(renders).toEqual({ parent: 1, a: 1, b: 1 });
    act(() => setCanvasHover('a'));
    expect(getByTestId('a').dataset.hot).toBe('1');
    expect(renders).toEqual({ parent: 1, a: 2, b: 1 });
    act(() => setCanvasHover('b'));
    expect(renders).toEqual({ parent: 1, a: 3, b: 2 });
    act(() => setCanvasHover('b')); // same value: nothing
    expect(renders).toEqual({ parent: 1, a: 3, b: 2 });
  });
});
