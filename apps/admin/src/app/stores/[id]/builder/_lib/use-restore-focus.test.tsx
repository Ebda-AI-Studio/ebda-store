// @vitest-environment jsdom
/**
 * A dialog the parent un-mounts hands focus back to its opener (it used to land on <body>).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { useRestoreFocus } from './use-restore-focus';

function Dialog({ onClose }: { onClose: () => void }) {
  useRestoreFocus();
  return (
    <div role="dialog">
      <button onClick={onClose}>inside</button>
    </div>
  );
}
function Host() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>opener</button>
      <button>other</button>
      {open && <Dialog onClose={() => setOpen(false)} />}
    </div>
  );
}

afterEach(cleanup);

describe('useRestoreFocus', () => {
  it('returns focus to the opener when the dialog unmounts', () => {
    render(<Host />);
    screen.getByText('opener').focus();
    fireEvent.click(screen.getByText('opener'));
    screen.getByText('inside').focus();
    fireEvent.click(screen.getByText('inside')); // unmounts the focused button: focus is lost
    expect(document.activeElement).toBe(screen.getByText('opener'));
  });

  it('leaves focus alone when it already went somewhere on purpose', () => {
    render(<Host />);
    screen.getByText('opener').focus();
    fireEvent.click(screen.getByText('opener'));
    screen.getByText('other').focus();
    fireEvent.click(screen.getByText('inside'));
    expect(document.activeElement).toBe(screen.getByText('other'));
  });
});
