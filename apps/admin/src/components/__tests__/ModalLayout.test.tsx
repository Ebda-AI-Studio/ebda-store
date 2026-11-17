// @vitest-environment jsdom
/**
 * Shared Modal: never taller than the viewport; header and footer stay
 * outside/sticky while the body scrolls; Esc closes; initial focus is inside.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Modal, ModalBody, ModalFooter } from '../../../../../packages/ui/src/components/Modal';

afterEach(cleanup);

describe('Modal layout', () => {
  it('caps height to the viewport, keeps header + footer, scrolls the body', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Edit plan" closeLabel="Close">
        <ModalBody>
          <input aria-label="first" />
        </ModalBody>
        <ModalFooter>
          <button>Save</button>
        </ModalFooter>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]');
    expect(dialog.className).toContain('flex-col');
    expect(screen.getByRole('heading', { name: 'Edit plan' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    const footerBtn = screen.getByRole('button', { name: 'Save' });
    expect(footerBtn.parentElement?.className).toContain('sticky');
    expect(footerBtn.parentElement?.parentElement?.className).toContain('overflow-y-auto');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
