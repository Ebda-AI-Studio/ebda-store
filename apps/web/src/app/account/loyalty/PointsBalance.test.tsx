// @vitest-environment jsdom
/**
 * #631: a negative points balance (a refund took back points already spent) is shown as 0 plus a "points owed" sentence,
 * in English and Egyptian Arabic, never as a bare negative number; the number is isolated with <bdi> for RTL.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PointsBalance } from './PointsBalance';

afterEach(cleanup);
const id = (s: string) => s;

describe('PointsBalance (#631)', () => {
  it.each(['en', 'ar'] as const)(
    '%s: a debt reads as points owed, with no minus sign',
    language => {
      const { container } = render(
        <PointsBalance points={-5000} language={language} localize={id} />
      );
      const owed = screen.getByTestId('points-owed');
      expect(owed.textContent).toMatch(language === 'ar' ? /عليك/ : /Points owed/);
      expect(owed.querySelector('bdi')?.textContent).toBe('5,000');
      expect(container.textContent).not.toMatch(/-\s?5,000|−5/);
      expect(container.querySelector('.text-5xl')?.textContent).toBe('0');
    }
  );
  it('a normal balance shows the number and no owed line', () => {
    const { container } = render(<PointsBalance points={1200} language="en" localize={id} />);
    expect(container.querySelector('.text-5xl')?.textContent).toBe('1,200');
    expect(screen.queryByTestId('points-owed')).toBeNull();
  });
});
