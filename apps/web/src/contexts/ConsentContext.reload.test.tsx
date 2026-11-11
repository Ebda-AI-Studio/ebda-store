// @vitest-environment jsdom
/** QA-C2: a first-time "reject all" must not reload the page; turning marketing ON must. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { ConsentProvider, useConsent } from './ConsentContext';

const reload = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  reload.mockClear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, protocol: 'https:', reload },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Buttons() {
  const { setConsent, hasDecided } = useConsent();
  return (
    <>
      <button onClick={() => setConsent({ marketing: false })}>reject</button>
      <button onClick={() => setConsent({ marketing: true })}>accept</button>
      <span data-testid="decided">{String(hasDecided)}</span>
    </>
  );
}

describe('consent reload', () => {
  it('reject-all does not reload and the choice is persisted', () => {
    render(
      <ConsentProvider initialConsent={null}>
        <Buttons />
      </ConsentProvider>
    );
    fireEvent.click(screen.getByText('reject'));
    act(() => {
      vi.runAllTimers();
    });
    expect(reload).not.toHaveBeenCalled();
    expect(document.cookie).toContain('force-cookie-consent');
    expect(screen.getByTestId('decided').textContent).toBe('true');
  });

  it('accept-all reloads so the server renders the pixels', () => {
    render(
      <ConsentProvider initialConsent={null}>
        <Buttons />
      </ConsentProvider>
    );
    fireEvent.click(screen.getByText('accept'));
    act(() => {
      vi.runAllTimers();
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
