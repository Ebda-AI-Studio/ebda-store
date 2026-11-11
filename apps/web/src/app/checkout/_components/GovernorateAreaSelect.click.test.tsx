// @vitest-environment jsdom
/** QA-C7: a pointer/tap CLICK on a combobox option must commit (it used to commit on mousedown only). */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { GovernorateAreaSelect } from './GovernorateAreaSelect';

afterEach(cleanup);

describe('GovernorateAreaSelect option click', () => {
  it('commits the governorate on a click of an option', () => {
    const onChange = vi.fn();
    render(<GovernorateAreaSelect governorate="" area="" onChange={onChange} locale="ar" />);
    fireEvent.focus(screen.getAllByRole('combobox')[0]);
    const option = screen.getAllByRole('option')[0];
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalled();
  });
});
