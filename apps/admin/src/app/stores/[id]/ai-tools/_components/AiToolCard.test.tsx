// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { AiToolCard } from './AiToolCard';

type AiToolCardProps = ComponentProps<typeof AiToolCard>;

afterEach(cleanup);

const base: AiToolCardProps = {
  id: 'tool-seo',
  title: 'Google titles',
  outcome: 'A search title for every product.',
  body: 'Fills the empty ones only.',
  costLabel: 'Uses about 1 AI call per product',
  buttonLabel: 'Write search text',
  startingLabel: 'Starting…',
  loading: false,
  blockedReason: null,
  onRun: () => {},
  replace: { label: 'Replace', hint: 'Overwrites what is there.', noUndo: "Can't be undone." },
};

describe('AiToolCard states', () => {
  it('idle: shows outcome and the cost BEFORE running, button enabled', () => {
    render(<AiToolCard {...base} />);
    expect(screen.getByText('A search title for every product.')).toBeTruthy();
    expect(screen.getByTestId('tool-cost').textContent).toContain('1 AI call');
    expect(
      (screen.getByRole('button', { name: /Write search text/ }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(screen.queryByTestId('blocked-reason')).toBeNull();
  });

  it('shows the estimated AI calls next to Run when the server gave one, and nothing when it did not', () => {
    const { rerender } = render(
      <AiToolCard {...base} estimateLabel="Up to 12 AI calls for this run" />
    );
    expect(screen.getByTestId('tool-estimate').textContent).toBe('Up to 12 AI calls for this run');
    rerender(<AiToolCard {...base} />);
    expect(screen.queryByTestId('tool-estimate')).toBeNull();
  });

  it('runs without force by default and with force once replace is ticked', () => {
    const onRun = vi.fn();
    render(<AiToolCard {...base} onRun={onRun} />);
    fireEvent.click(screen.getByRole('button', { name: /Write search text/ }));
    expect(onRun).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByLabelText('Replace'));
    expect(screen.getByTestId('replace-hint').textContent).toContain("Can't be undone.");
    fireEvent.click(screen.getByRole('button', { name: /Write search text/ }));
    expect(onRun).toHaveBeenLastCalledWith(true);
  });

  it('a fill-only tool has no replace switch and never sends force', () => {
    const onRun = vi.fn();
    render(<AiToolCard {...base} replace={undefined} onRun={onRun} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Write search text/ }));
    expect(onRun).toHaveBeenCalledWith(false);
  });

  it('a fill-only tool says why there is no replace switch', () => {
    render(<AiToolCard {...base} replace={undefined} fillOnlyNote="Never overwrites your text." />);
    expect(screen.getByTestId('fill-only-note').textContent).toBe('Never overwrites your text.');
  });

  it('loading: shows the starting label and blocks a second click', () => {
    render(<AiToolCard {...base} loading />);
    const b = screen.getByRole('button', { name: /Starting/ }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
  });

  it('quota exhausted / AI off / another run: disabled with the reason written next to it', () => {
    const onRun = vi.fn();
    render(<AiToolCard {...base} blockedReason="Today's AI limit is used up." onRun={onRun} />);
    const b = screen.getByRole('button', { name: /Write search text/ }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(screen.getByTestId('blocked-reason').textContent).toBe("Today's AI limit is used up.");
    expect(b.getAttribute('aria-describedby')).toBe(screen.getByTestId('blocked-reason').id);
    fireEvent.click(b);
    expect(onRun).not.toHaveBeenCalled();
  });

  it('results link renders for tools that write to another page; undo tool is not the gold button', () => {
    render(<AiToolCard {...base} results={{ href: '/stores/1/seo', label: 'See them' }} isUndo />);
    expect(screen.getByRole('link', { name: /See them/ }).getAttribute('href')).toBe(
      '/stores/1/seo'
    );
    expect(screen.getByRole('button', { name: /Write search text/ }).className).toContain(
      'border-input'
    );
  });
});
