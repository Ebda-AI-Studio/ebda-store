// @vitest-environment jsdom
/** STORE-QA-48: a contact row with no value is hidden, never "Not available". */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render } from '@testing-library/react';

const state = vi.hoisted(() => ({
  store: { name: 'S', settings: {}, email: null, phone: null, address: null } as Record<
    string,
    unknown
  >,
}));
vi.mock('@/lib/api', () => ({ api: { submitContact: vi.fn() } }));
vi.mock('../../components', () => ({
  ShopChrome: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@ebda/ui', () => ({
  Button: ({
    children,
    isLoading: _l,
    ...p
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) => (
    <button {...p}>{children}</button>
  ),
  Input: ({ label, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) => (
    <label>
      {label}
      <input {...p} />
    </label>
  ),
  Textarea: ({
    label,
    ...p
  }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) => (
    <label>
      {label}
      <textarea {...p} />
    </label>
  ),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../contexts/StoreContext', () => ({ useStore: () => ({ store: state.store }) }));
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', isRtl: false, t: (en: string) => en }),
  translations: {} as Record<string, string>,
}));
vi.mock('../../templates/shared/display-helpers', () => ({
  resolveAddressHref: (a: string | null) =>
    a ? `https://maps.example/?q=${encodeURIComponent(a)}` : null,
}));

import ContactClient from './ContactClient';

afterEach(cleanup);

describe('ContactClient detail rows', () => {
  it('a store with no email, phone or address shows no detail rows and no placeholder text', () => {
    state.store = { name: 'S', settings: {}, email: null, phone: null, address: null };
    const { container, queryByText } = render(<ContactClient />);
    expect(queryByText('Not available')).toBeNull();
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
    expect(queryByText('Email')).toBeNull();
    expect(queryByText('Phone')).toBeNull();
    expect(queryByText('Location')).toBeNull();
  });

  it('only the rows the store has are shown, as working links', () => {
    state.store = {
      name: 'S',
      settings: {},
      email: 'hi@shop.example',
      phone: '+20 100 000 0000',
      address: null,
    };
    const { container, queryByText } = render(<ContactClient />);
    expect(container.querySelector('a[href="mailto:hi@shop.example"]')?.textContent).toBe(
      'hi@shop.example'
    );
    expect(container.querySelector('a[href="tel:+201000000000"]')).not.toBeNull();
    expect(queryByText('Location')).toBeNull();
    expect(queryByText('Not available')).toBeNull();
  });
});
