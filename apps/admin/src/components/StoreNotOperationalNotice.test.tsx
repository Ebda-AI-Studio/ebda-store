// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../i18n/useT', () => ({ useT: () => (key: string) => key }));

import { StoreNotOperationalNotice } from './StoreNotOperationalNotice';
import { STORE_NOT_OPERATIONAL_EVENT } from '../lib/api';

afterEach(cleanup);

describe('StoreNotOperationalNotice', () => {
  it('stays hidden, then shows the suspension message with an appeal link on the 423 event, and closes', () => {
    render(<StoreNotOperationalNotice />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent(STORE_NOT_OPERATIONAL_EVENT));
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('storeNotOperational')).toBeTruthy();
    const appeal = screen.getByText('storeNotOperationalAppeal') as HTMLAnchorElement;
    expect(appeal.getAttribute('href')).toMatch(/^mailto:.+\?subject=/);
    fireEvent.click(screen.getByText('close'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
