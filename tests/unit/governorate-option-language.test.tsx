// @vitest-environment jsdom
/**
 * a11y re-audit P2-N13 (WCAG 3.1.2): the governorate and area options read "Cairo / القاهرة" in
 * the Arabic UI, two languages in one name. Each option names itself in the page language; the
 * other language still matches when typed, so a shopper can type "Giza" on the Arabic page.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { GovernorateAreaSelect } from '../../apps/web/src/app/checkout/_components/GovernorateAreaSelect';

afterEach(cleanup);

describe('governorate options speak the page language (P2-N13)', () => {
  it('Arabic page: no Latin in an option name, and an English query still matches', () => {
    render(<GovernorateAreaSelect governorate="" area="" onChange={() => {}} locale="ar" />);
    const combo = screen.getAllByRole('combobox')[0];
    fireEvent.focus(combo);
    fireEvent.click(combo);
    const opts = screen.getAllByRole('option');
    expect(opts.length).toBeGreaterThan(20);
    for (const o of opts) expect(o.textContent).not.toMatch(/[A-Za-z]/);
    fireEvent.change(combo, { target: { value: 'Giza' } });
    expect(screen.getAllByRole('option').map(o => o.textContent)).toContain('الجيزة');
  });
  it('English page: no Arabic in an option name', () => {
    render(<GovernorateAreaSelect governorate="" area="" onChange={() => {}} locale="en" />);
    const combo = screen.getAllByRole('combobox')[0];
    fireEvent.focus(combo);
    fireEvent.click(combo);
    for (const o of screen.getAllByRole('option')) expect(o.textContent).not.toMatch(/[؀-ۿ]/);
  });
});
