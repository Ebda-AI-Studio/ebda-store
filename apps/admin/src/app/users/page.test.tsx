// @vitest-environment jsdom
/**
 * Issue 2443 — an invite started on page 1 and resolved after the admin paged (or changed the role
 * filter) refetched through a `fetchUsers` captured from the old render and painted the OLD
 * page/filter under the new pager. The handler now bumps a refreshKey; the one fetch effect owns
 * every list request and is latest-wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Pending = { url: string; resolve: (v: unknown) => void };

const { apiGet, apiPost, calls, posts } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  calls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
  posts: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('@/lib/api', () => ({
  apiGet,
  apiPost,
  fieldErrorsFrom: (d?: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(d ?? {}).flatMap(([k, v]) => (Array.isArray(v) ? [[k, String(v[0])]] : []))
    ),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/useDebouncedValue', () => ({ useDebouncedValue: (v: string) => v }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@ebda/ui', () => ({
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest}>{children}</button>
  ),
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
  ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
}));
// Stable `t` identity: it is a fetchUsers dependency, as with the real hook.
vi.mock('@/i18n/useT', () => {
  const t = (key: string) => key;
  return { useT: () => t };
});
vi.mock('@/components/AdminLayout', () => ({
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
vi.mock('@/components/ErrorState', () => ({ ErrorState: () => null }));
vi.mock('@/components/mobile/DataTable', () => ({
  DataTable: ({
    rows,
    columns,
  }: {
    rows: Array<Record<string, unknown>>;
    columns: Array<{ cell: (r: Record<string, unknown>) => React.ReactNode }>;
  }) => (
    <div>
      {rows.map(r => (
        <div key={String(r.id)}>
          {columns.map((c, i) => (
            <span key={i}>{c.cell(r)}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}));

import UsersPage from './page';

const qp = (url: string, k: string) => new URL(url, 'http://x').searchParams.get(k);

function respond(d: Pending) {
  const page = Number(qp(d.url, 'page'));
  const role = qp(d.url, 'role') ?? 'all';
  d.resolve({
    data: {
      users: [
        {
          id: `u${page}`,
          email: `u${page}@x.test`,
          firstName: `USR-${role}-${page}`,
          lastName: '',
          role: 'store_admin',
          status: 'active',
          createdAt: '2026-02-01T00:00:00Z',
          lastLoginAt: null,
        },
      ],
      pagination: { page, limit: 10, total: 30, totalPages: 3 },
    },
    error: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  posts.length = 0;
  apiGet.mockImplementation((url: string) => new Promise(resolve => calls.push({ url, resolve })));
  apiPost.mockImplementation((url: string) => new Promise(resolve => posts.push({ url, resolve })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function loadFirstPage() {
  const view = render(<UsersPage />);
  await waitFor(() => expect(calls).toHaveLength(1));
  await act(async () => respond(calls[0]));
  await screen.findByText('USR-all-1');
  return view;
}

function submitInvite(container: HTMLElement) {
  fireEvent.click(screen.getAllByText('inviteUser')[0]);
  const form = container.querySelector('#invite-email')!.closest('form') as HTMLFormElement;
  fireEvent.submit(form); // POST in flight, started on page 1 / role all
}

describe('users list — post-invite refetch reads CURRENT page/role filter (issue 2443)', () => {
  it('an invite resolving after the pager moved repaints the CURRENT page', async () => {
    const { container } = await loadFirstPage();
    submitInvite(container);
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(calls).toHaveLength(2));

    await act(async () => posts[0].resolve({ data: { user: {} }, error: null }));
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    for (const c of calls.slice(1)) await act(async () => respond(c));

    expect(screen.getByText('USR-all-2')).toBeTruthy();
    expect(screen.queryByText('USR-all-1')).toBeNull();
    expect(qp(calls[calls.length - 1].url, 'page')).toBe('2');
  });

  it('an invite resolving after the role filter changed repaints the CURRENT filter', async () => {
    const { container } = await loadFirstPage();
    submitInvite(container);
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('filterRoleLabel'), {
      target: { value: 'super_admin' },
    });
    await waitFor(() => expect(calls).toHaveLength(2));

    await act(async () => posts[0].resolve({ data: { user: {} }, error: null }));
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    for (const c of calls.slice(1)) await act(async () => respond(c));

    expect(screen.getByText('USR-super_admin-1')).toBeTruthy();
    expect(screen.queryByText('USR-all-1')).toBeNull();
    expect(qp(calls[calls.length - 1].url, 'role')).toBe('super_admin');
  });

  it('an older list response landing last never repaints (latest-wins guard)', async () => {
    await loadFirstPage();
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(calls).toHaveLength(3));

    await act(async () => respond(calls[2])); // page 3 first
    await act(async () => respond(calls[1])); // page 2 lands LAST

    expect(screen.getByText('USR-all-3')).toBeTruthy();
    expect(screen.queryByText('USR-all-2')).toBeNull();
  });
});

describe('invite form role', () => {
  it('no longer offers super_admin and explains where platform admins come from', async () => {
    const { container } = await loadFirstPage();
    fireEvent.click(screen.getAllByText('inviteUser')[0]);
    const options = Array.from(container.querySelectorAll('#invite-role option')).map(
      o => (o as HTMLOptionElement).value
    );
    expect(options).toEqual(['store_admin']);
    expect(screen.getByText('inviteRoleHelp')).toBeTruthy();
  });

  it('renders the field-level error from the API under the field', async () => {
    const { container } = await loadFirstPage();
    submitInvite(container);
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(async () =>
      posts[0].resolve({
        data: null,
        error: { message: 'bad', details: { email: ['Invalid email'] } },
      })
    );
    expect(await screen.findByText('Invalid email')).toBeTruthy();
  });
});
