// @vitest-environment jsdom
/** Category form: the API's field-level validation error lands under the field it names. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock('../../../../lib/api', async importActual => ({
  ...(await importActual<typeof import('../../../../lib/api')>()),
  apiGet,
  apiPost,
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => {
  const t = (key: string) => key; // stable identity: it is a fetch dependency, as with the real hook
  return { useT: () => t };
});
vi.mock('@ebda/ui', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/ui/Button', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({
    children,
    actions,
  }: {
    children: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));
vi.mock('../../../../components/ImageUpload', () => ({ ImageUpload: () => null }));
vi.mock('../../../../components/SearchInput', () => ({ SearchInput: () => null }));
vi.mock('../../../../components/RowActions', () => ({ RowActions: () => null }));
vi.mock('./CategoryTable', () => ({ CategoryTable: () => null }));
vi.mock('./CategorySuggestionPanel', () => ({ CategorySuggestionPanel: () => null }));
vi.mock('./CategoryForm', () => ({
  CategoryForm: (p: {
    form: Record<string, unknown>;
    formErrors: Record<string, string>;
    onFormChange: (f: Record<string, unknown>) => void;
    onSubmit: (e: React.FormEvent) => void;
  }) => (
    <form onSubmit={p.onSubmit}>
      <button
        type="button"
        onClick={() => p.onFormChange({ ...p.form, name: 'Tees', slug: 'tees' })}
      >
        fill
      </button>
      <button type="submit">submit</button>
      <output data-testid="errs">{JSON.stringify(p.formErrors)}</output>
    </form>
  ),
}));

import CategoriesPage from './page';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  apiGet.mockResolvedValue({ data: { categories: [] }, error: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('category form', () => {
  it('puts the API name error under the name field instead of a generic line', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { message: 'bad', status: 400, details: { name: ['Name is too long'] } },
    });
    render(<CategoriesPage />);
    fireEvent.click(await screen.findByText('addCategory'));
    fireEvent.click(screen.getByText('fill'));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('errs').textContent ?? '{}')).toEqual({
        name: 'Name is too long',
      })
    );
  });
});
